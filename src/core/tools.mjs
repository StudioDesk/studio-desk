// A studio tool's record and its checks (1.4, tools, step 1): what the studio records about a tool its agents may use,
// and the rules a record must keep. A tool is one of two kinds: a command, a single program on this computer (such as
// ffmpeg or magick) with where to get it when it is missing, or a studio call, a service the studio calls at an https
// address through the operations its record declares. Every tool has a name, a line on what it is for, the rules an
// agent follows when using it, and limits on calls per hour and per attempt, a time limit and the largest answer.
//
// Domain-free: no routes or pages, and no imports from packs, connectors or the server. The record's checks are pure.
// A record never holds a key: checked input refuses any key, secret, token, password or header field, and toolKey()
// says no key is set. A command names a program, never a shell line. A studio call can only ever be built from an
// operation its record declares, with the arguments that operation declares (operationRequest), so undeclared input
// never reaches the address.
//
// The studio's tool list (1.4, tools, step 2) keeps the records in the store it is given, each as the studio setting
// tool:<id> with no project. Adding one gives it an ID the controller makes and revision 1; a change or retiring names
// the revision it changes and is refused when that revision is out of date; every write raises the revision and goes
// on the change stream as { type: 'tool', id, revision } (core/store.mjs). Retiring keeps the record: nothing here
// deletes a tool. Each read says what its reader may do, and reads the key as not set.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const toolKinds = Object.freeze(['command', 'studio-call']);
export const toolMethods = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
// The largest value each limit may take.
export const toolLimitBounds = Object.freeze({
  callsPerHour: 10000,
  callsPerAttempt: 1000,
  timeoutSeconds: 600,
  maxResponseBytes: 10 * 1024 * 1024,
});

const limitNames = Object.freeze({
  callsPerHour: 'Calls per hour',
  callsPerAttempt: 'Calls per attempt',
  timeoutSeconds: 'The time limit in seconds',
  maxResponseBytes: 'The largest answer in bytes',
});
const commonFields = ['name', 'purpose', 'kind', 'rules', 'limits'];
const kindFields = { command: ['program', 'getFrom'], 'studio-call': ['address', 'operations'] };
const operationFields = ['name', 'method', 'path', 'arguments', 'required'];
// A field that would carry a key or what opens a service. None is ever part of a record.
const secretField = /key|secret|token|password|passwd|credential|auth|header|cookie/i;
// A program: one name, never a path or a shell line.
const programName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// An operation's or argument's name.
const identifier = /^[A-Za-z0-9_-]{1,64}$/;
const literalSegment = /^[A-Za-z0-9._~-]+$/;
const placeholderSegment = /^\{([A-Za-z0-9_-]{1,64})\}$/;
const maxOperations = 50,
  maxArguments = 20,
  maxPathLength = 300,
  maxAddressLength = 2048;

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
// A name from the input, shortened, for a message.
const quoted = value => {
  const text = String(value);
  return `"${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;
};
function text(value, min, max, message) {
  if (value !== undefined && typeof value !== 'string') throw failure(message);
  const trimmed = (value ?? '').trim();
  if (trimmed.length < min || trimmed.length > max) throw failure(message);
  return trimmed;
}
// Refuses any field outside `allowed`, and a field that would carry a key with a message that says so.
function closed(object, allowed, only) {
  for (const field of Object.keys(object)) {
    if (allowed.includes(field)) continue;
    if (secretField.test(field))
      throw failure(`A tool record never holds a key, secret, token, password or header: leave out ${quoted(field)}.`);
    throw failure(`${only}: leave out ${quoted(field)}.`);
  }
}

function checkLimits(limits) {
  const all = 'calls per hour, calls per attempt, a time limit in seconds and the largest answer in bytes';
  if (!plainObject(limits)) throw failure(`Set the tool's limits: ${all}.`);
  closed(limits, Object.keys(toolLimitBounds), `The limits are only ${all}`);
  return Object.fromEntries(
    Object.entries(toolLimitBounds).map(([field, bound]) => {
      const value = limits[field];
      if (!Number.isInteger(value) || value < 1 || value > bound)
        throw failure(`${limitNames[field]} must be a whole number from 1 to ${bound}.`);
      return [field, value];
    }),
  );
}

function checkProgram(program) {
  if (typeof program !== 'string' || !programName.test(program))
    throw failure(
      'Name one program, such as ffmpeg or magick: 1 to 64 letters, digits, dots, underscores or hyphens, starting ' +
        'with a letter or digit, with no spaces, folders, quotes or shell characters.',
    );
  return program;
}

// The address a studio call is made at, without a trailing slash so a path joins it: https only, with a host, and
// with nothing secret in it (no user name, password, query string or fragment). The address is never repeated in a
// message.
function checkAddress(address) {
  if (typeof address === 'string' && address.length > maxAddressLength)
    throw failure(`A studio call's address is at most ${maxAddressLength} characters.`);
  let url;
  try {
    url = new URL(address);
  } catch {
    throw failure('Give the studio call a full address with a host, such as https://api.example.com.');
  }
  if (url.protocol !== 'https:') throw failure("A studio call's address must start with https://.");
  if (!url.hostname) throw failure("A studio call's address must name a host.");
  if (url.username || url.password) throw failure('An address never carries a user name or password.');
  // The serialized address keeps an empty query (`?`) or fragment (`#`), which the search and hash properties hide;
  // a path's own ? and # are always escaped, so the first # starts the fragment and a ? before it the query.
  const [beforeFragment] = url.href.split('#');
  if (beforeFragment.includes('?'))
    throw failure("An address has no query string: list what a call sends as its operation's arguments.");
  if (url.href.includes('#')) throw failure('An address has no fragment (the part after #).');
  return url.href.replace(/\/+$/, '');
}

const pathSegments = route => route.slice(1).split('/');

function checkOperation(operation, names) {
  if (!plainObject(operation))
    throw failure('Each operation is an object of its name, method, path, arguments and required arguments.');
  closed(operation, operationFields, 'An operation takes only a name, method, path, arguments and required arguments');
  const { name, method, path: route } = operation;
  if (typeof name !== 'string' || !identifier.test(name))
    throw failure('Name each operation with 1 to 64 letters, digits, hyphens or underscores.');
  if (names.has(name)) throw failure(`Two operations are named ${quoted(name)}: give each its own name.`);
  names.add(name);
  if (!toolMethods.includes(method))
    throw failure(`The operation ${quoted(name)} uses GET, POST, PUT, PATCH or DELETE.`);
  const declared = operation.arguments ?? [],
    required = operation.required ?? [];
  if (
    !Array.isArray(declared) ||
    declared.length > maxArguments ||
    declared.some(argument => typeof argument !== 'string' || !identifier.test(argument)) ||
    new Set(declared).size !== declared.length
  )
    throw failure(
      `The operation ${quoted(name)} lists at most ${maxArguments} arguments, each named once with 1 to 64 letters, ` +
        'digits, hyphens or underscores.',
    );
  if (
    !Array.isArray(required) ||
    required.some(argument => !declared.includes(argument)) ||
    new Set(required).size !== required.length
  )
    throw failure(`The operation ${quoted(name)} can require only arguments it lists, each once.`);
  if (typeof route !== 'string' || !route.startsWith('/') || route.length > maxPathLength)
    throw failure(
      `The operation ${quoted(name)} needs a path of at most ${maxPathLength} characters starting with /, such as ` +
        '/items/{id}.',
    );
  if (/[?#]/.test(route))
    throw failure(`The path of ${quoted(name)} has no query string or fragment: list what it sends as arguments.`);
  for (const segment of pathSegments(route)) {
    if (!segment)
      throw failure(`The path of ${quoted(name)} has no empty part (two slashes together, or one at the end).`);
    if (segment === '.' || segment === '..') throw failure(`The path of ${quoted(name)} has no "." or ".." part.`);
    const placeholder = placeholderSegment.exec(segment);
    if (placeholder) {
      if (!declared.includes(placeholder[1]))
        throw failure(
          `The path of ${quoted(name)} names {${placeholder[1]}}, which is not one of the operation's arguments.`,
        );
    } else if (!literalSegment.test(segment))
      throw failure(
        `Each part of the path of ${quoted(name)} is letters, digits or . _ ~ -, or a whole {argument} it lists.`,
      );
  }
  return { name, method, path: route, arguments: [...declared], required: [...required] };
}

function checkOperations(operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > maxOperations)
    throw failure(`A studio call lists from 1 to ${maxOperations} operations.`);
  const names = new Set();
  return operations.map(operation => checkOperation(operation, names));
}

// The fields the director supplies, checked and normalized into a record's body; an Error with status 400 and a plain
// message otherwise.
export function checkToolInput(input) {
  if (!plainObject(input)) throw failure('Give a tool as an object of its fields.');
  closed(
    input,
    [...commonFields, ...kindFields.command, ...kindFields['studio-call']],
    "A tool takes only a name, purpose, kind, rules, limits and its kind's own fields",
  );
  const { kind } = input;
  if (!toolKinds.includes(kind))
    throw failure(
      'A tool is either a command (a program on this computer) or a studio call (a service the studio calls).',
    );
  if (kind === 'command' && kindFields['studio-call'].some(field => Object.hasOwn(input, field)))
    throw failure('A command names a program and where to get it; it has no address or operations.');
  if (kind === 'studio-call' && kindFields.command.some(field => Object.hasOwn(input, field)))
    throw failure('A studio call has an address and its operations; it has no program or where to get one.');
  const body = {
    name: text(input.name, 1, 80, 'Give the tool a name of 1 to 80 characters.'),
    purpose: text(input.purpose, 1, 500, 'Say what the tool is for in 1 to 500 characters.'),
    kind,
    rules: text(input.rules, 0, 8000, 'The rules for using the tool are at most 8000 characters.'),
  };
  if (kind === 'command') {
    body.program = checkProgram(input.program);
    body.getFrom = text(
      input.getFrom,
      1,
      500,
      'Say where to get the program when this computer does not have it, in 1 to 500 characters.',
    );
  } else {
    body.address = checkAddress(input.address);
    body.operations = checkOperations(input.operations);
  }
  body.limits = checkLimits(input.limits);
  return body;
}

// The record's key state. No key can be set in this step, and checked input never supplies one.
export const toolKey = () => ({ set: false });

// Whether this computer has a program: a plain file in one of the PATH folders, trying each PATHEXT extension too on
// Windows. Answers only true or false, never where the program is. Relative PATH folders are skipped, so the answer
// does not depend on the folder the controller was started from.
export function programOnPath(program, { environment = process.env, platform = process.platform } = {}) {
  if (typeof program !== 'string' || !programName.test(program)) return false;
  // Windows names its variables in any case (Path is common); a copied environment keeps whichever it had.
  const variable = name =>
    platform === 'win32'
      ? Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1]
      : environment[name];
  const extensions =
    platform === 'win32' ? ['', ...(variable('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const folders = (variable('PATH') || '')
    .split(path.delimiter)
    .map(folder => (platform === 'win32' ? folder.replace(/^"(.*)"$/, '$1') : folder))
    .filter(folder => folder && path.isAbsolute(folder));
  for (const folder of folders)
    for (const extension of extensions)
      try {
        const candidate = path.join(folder, program + extension);
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Not here.
      }
  return false;
}

// Whether this computer has a command's program: found, or missing with where to get it. Null for a studio call.
// `find` is asked only whether it locates the program; whatever it returns, the answer never names a local path.
export function programAvailability(record, find = programOnPath) {
  if (record?.kind === 'studio-call') return null;
  if (record?.kind !== 'command') throw failure('A tool is either a command or a studio call.');
  const program = checkProgram(record.program);
  let found = false;
  try {
    found = !!find(program);
  } catch {
    found = false;
  }
  return found ? { state: 'found' } : { state: 'missing', getFrom: record.getFrom };
}

// The only way to build a studio call: one operation the record declares, with only the arguments it declares. Each
// path placeholder becomes its argument, encoded; the declared arguments not in the path are the query. Returns
// { method, url, query }; an Error with status 400 otherwise.
export function operationRequest(record, operationName, args = {}) {
  if (record?.kind !== 'studio-call' || !Array.isArray(record.operations) || typeof record.address !== 'string')
    throw failure('This tool is not a studio call, so it makes no calls.');
  const operation = record.operations.find(item => item?.name === operationName);
  if (typeof operationName !== 'string' || !operation)
    throw failure(`This tool has no operation named ${quoted(operationName)}.`);
  if (!plainObject(args)) throw failure('Give the arguments as an object of names and values.');
  const declared = operation.arguments || [],
    required = operation.required || [];
  for (const argument of Object.keys(args)) {
    if (!declared.includes(argument))
      throw failure(`The operation ${quoted(operation.name)} takes no argument ${quoted(argument)}.`);
    const value = args[argument];
    if (!(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))))
      throw failure(`The argument ${quoted(argument)} must be text or a number.`);
  }
  for (const argument of required)
    if (!Object.hasOwn(args, argument))
      throw failure(`The operation ${quoted(operation.name)} needs the argument ${quoted(argument)}.`);
  const inPath = new Set();
  const segments = pathSegments(operation.path).map(segment => {
    const placeholder = placeholderSegment.exec(segment);
    if (!placeholder) return segment;
    const argument = placeholder[1];
    if (!Object.hasOwn(args, argument))
      throw failure(`The operation ${quoted(operation.name)} needs the argument ${quoted(argument)} for its path.`);
    const value = String(args[argument]);
    // An empty, "." or ".." part would change which path the call reaches.
    if (value === '' || value === '.' || value === '..')
      throw failure(`The argument ${quoted(argument)} fills part of the path, so it cannot be empty, "." or "..".`);
    inPath.add(argument);
    return encodeURIComponent(value);
  });
  const query = Object.fromEntries(
    declared
      .filter(argument => !inPath.has(argument) && Object.hasOwn(args, argument))
      .map(argument => [argument, args[argument]]),
  );
  return { method: operation.method, url: `${record.address}/${segments.join('/')}`, query };
}

// The most tools the studio keeps, retired ones included, since a retired tool is never removed.
export const maxTools = 200;
// What a read of a tool carries from its stored record, in this order; nothing else a record might hold is read.
const readFields = ['id', 'name', 'purpose', 'kind', 'rules', 'program', 'getFrom', 'address', 'operations', 'limits'];
const recordFields = ['revision', 'createdAt', 'updatedAt', 'by'];

// The director's fields from an add or a change. An ID in the input is ignored: the controller names every tool.
function directorInput(input) {
  if (!plainObject(input)) return input;
  const { id, ...fields } = input;
  return fields;
}

// The record a change or retiring starts from: refused when the revision it names is not the current one, or when the
// tool is retired, so nothing is saved over a change the director has not seen.
function currentRecord(store, id, expectedRevision, retiredMessage) {
  const record = store.tool(id);
  if (expectedRevision !== record.revision) throw failure('Tool changed. Refresh before saving.', 409);
  if (record.retiredAt) throw failure(retiredMessage, 409);
  return record;
}

// Adds a tool from the director's checked fields, with an ID the controller makes and never reuses.
export function addTool(store, input, by = 'director') {
  const body = checkToolInput(directorInput(input));
  return store.tx(() => {
    if (store.tools().length >= maxTools)
      throw failure(`The studio keeps at most ${maxTools} tools, retired ones included.`);
    const now = new Date().toISOString();
    const record = {
      id: 'tool-' + randomUUID(),
      ...body,
      key: toolKey(),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      by,
    };
    store.putTool(record);
    return record;
  });
}

// Replaces the director's fields of the tool at expectedRevision with the checked input, keeping its ID, when it was
// added and its key state.
export function changeTool(store, id, expectedRevision, input, by = 'director') {
  const body = checkToolInput(directorInput(input));
  return store.tx(() => {
    const previous = currentRecord(store, id, expectedRevision, 'This tool is retired, so it cannot be changed.');
    const record = {
      id: previous.id,
      ...body,
      key: previous.key ?? toolKey(),
      revision: previous.revision + 1,
      createdAt: previous.createdAt,
      updatedAt: new Date().toISOString(),
      by,
    };
    store.putTool(record);
    return record;
  });
}

// Retires the tool at expectedRevision. The record is kept, marked by when it was retired.
export function retireTool(store, id, expectedRevision, by = 'director') {
  return store.tx(() => {
    const previous = currentRecord(store, id, expectedRevision, 'This tool is already retired.');
    const now = new Date().toISOString();
    const record = { ...previous, revision: previous.revision + 1, updatedAt: now, by, retiredAt: now };
    store.putTool(record);
    return record;
  });
}

// What a reader may do with a tool, worked out by the controller: the director may change or retire an active tool;
// a retired tool takes no action, and any other reader (an agent's attempt) none either.
export function toolActions(record, reader) {
  return reader === 'director' && !record?.retiredAt ? ['change', 'retire'] : [];
}

// A tool as read: its stored fields, the key as not set and nothing else about a key, whether this computer has a
// command's program (null for a studio call), when it was retired (null while active) and what the reader may do.
function readRecord(record, { reader = 'director', find } = {}) {
  const read = {};
  for (const field of readFields) if (Object.hasOwn(record, field)) read[field] = record[field];
  read.key = toolKey();
  for (const field of recordFields) read[field] = record[field];
  read.retiredAt = record.retiredAt ?? null;
  read.availability = programAvailability(record, find);
  read.actions = toolActions(record, reader);
  return read;
}

// Every tool the studio keeps, retired ones included, in the order they were added.
export function readTools(store, { reader = 'director', find } = {}) {
  return store.tools().map(record => readRecord(record, { reader, find }));
}

// One tool; an Error with status 404 when there is none.
export function readTool(store, id, options) {
  return readRecord(store.tool(id), options);
}
