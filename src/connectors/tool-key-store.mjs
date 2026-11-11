// A studio tool's key, kept in this computer's own credential store (1.4, tools): one secret per tool, under the
// service name "Studio desk tool key" with the tool's ID as the account. The tool commands keep, replace, remove and
// read it through this module and change the tool's record in the same controller step, so every call here is
// synchronous; the record itself holds only whether a key is set (core/tools.mjs).
//
// Where the key lives:
// - Windows: this user's protected storage (the system's data protection, DPAPI, CurrentUser scope). Windows
//   PowerShell, started with a fixed script, protects the key it reads on its standard input and answers the protected
//   bytes, which this module writes to <data>/tool-keys/<tool id>.dpapi. Reading hands those bytes back to it to
//   unprotect; removing deletes the file. PowerShell reads its standard input as text in the console's code page, so
//   the key travels there as base64 of its UTF-8 bytes and comes back the same way, and no code page changes it.
// - macOS: this user's Keychain, through the security program's interactive mode (security -i), its one command line
//   sent on standard input with each value in double quotes, so spaces and quotes survive.
// - Linux and other systems: the Secret Service through secret-tool when this computer has it, or else a file
//   <data>/tool-keys/<tool id>.key only this user can read (mode 0600 in a folder of mode 0700). The file is less safe:
//   lessSafe and where() say so, so the tool can carry a plain warning. A secret-tool that is found but fails is
//   refused, never replaced by the file.
//
// The key reaches a program only on its standard input, never in the program or its arguments, so it never shows in
// the list of running programs, and a program's answer is kept in memory only. Every failure is an Error in plain
// words naming the store, without the key, a program's output or a local path. Nothing here writes to the console or
// a log. The caller checks a key's length and characters; the store refuses only a key that is not text, and on macOS
// one its command line cannot carry.
//
// On Windows any process running as this user, an agent's CLI or a test included, can unprotect the protected files,
// so the tool-keys folder is kept from agents and tests exactly as the director's key is: its name is the one constant
// toolKeysFolderName of director-access.mjs, which directorSecretNames lists for every sandbox's deny rules.
//
// Imports nothing from the server or packs. Tests inject the runner and the program finder.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { programOnPath } from '../core/tools.mjs';
import { toolKeysFolderName } from '../director-access.mjs';

// The data folder's folder of key files, under the one name the agent and test sandboxes' deny rules use.
export { toolKeysFolderName };
export const toolKeysFolder = directory => path.join(directory, toolKeysFolderName);
// The name the studio owns for every tool's key in the system's store; the tool's ID is the account.
export const toolKeyService = 'Studio desk tool key';
// How long a store's program may take before it is stopped.
export const toolKeyTimeout = 15000;

// Tool IDs are made by the controller (tool-<uuid>); nothing else names a key's account or file.
const toolId = /^tool-[A-Za-z0-9_-]{1,100}$/;
// The security program reads an interactive line into a buffer of 4096 bytes, so a longer line would split into a
// second command; this leaves room to spare.
const keychainLineBytes = 4000;
// What the security program answers for an item it does not have (errSecItemNotFound as an exit status).
const keychainNotFound = 44;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// The stores, by kind, and how a message names each one.
const stores = {
  'protected-storage': {
    name: "This user's protected storage",
    program: "Windows PowerShell, which keeps keys in this user's protected storage,",
  },
  keychain: {
    name: "This computer's Keychain",
    program: "The security program, which keeps keys in this computer's Keychain,",
  },
  'secret-service': {
    name: "This computer's Secret Service",
    program: "The secret-tool program, which keeps keys in this computer's Secret Service,",
  },
};
const operations = {
  put: { refused: 'refused to keep the key', unfinished: 'so the key was not kept' },
  read: { refused: 'refused to give the key back', unfinished: 'so the key was not read' },
  remove: { refused: 'refused to remove the key', unfinished: 'so the key was not removed' },
  has: {
    refused: 'could not say whether it keeps the key',
    unfinished: 'so the studio could not tell whether it keeps the key',
  },
};
const fileFailures = {
  put: 'The studio could not write the key to its file.',
  read: 'The studio could not read the key from its file.',
  remove: "The studio could not remove the key's file.",
  has: "The studio could not tell whether the key's file is there.",
};

const plain = (message, status) => Object.assign(new Error(message), status ? { status } : {});

function checkId(id) {
  if (typeof id !== 'string' || !toolId.test(id)) throw plain("A tool's key is kept only under the tool's ID.", 400);
  return id;
}
function checkKey(key) {
  if (typeof key !== 'string') throw plain("A tool's key must be text.", 400);
  return key;
}

// Windows PowerShell's two fixed scripts. Each reads its standard input as base64 text and answers base64.
const scope = '[Security.Cryptography.DataProtectionScope]::CurrentUser';
const answer = variable => `[Console]::Out.Write([Convert]::ToBase64String(${variable}))`;
const readInput =
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Add-Type -AssemblyName System.Security;" +
  "$b=[Convert]::FromBase64String((@($input) -join '').Trim());";
const protectScript =
  readInput + `$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,${scope});` + answer('$p');
const unprotectScript =
  readInput + `$k=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,${scope});` + answer('$k');
const powerShellArgs = script => [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64'),
];
// The system's own copy, never one found first in the current folder or on PATH.
const windowsPowerShell = systemRoot =>
  path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// One value in a security command line: in double quotes, with each backslash and quote escaped.
const keychainValue = value => `"${value.replace(/[\\"']/g, character => `\\${character}`)}"`;
const keychainItem = id => `-s ${keychainValue(toolKeyService)} -a ${keychainValue(id)}`;

// The program, arguments and standard input for one operation on one store; null for an operation done on the data
// folder's files alone (Windows removes and checks its protected file itself). The key is only ever in input.
// Exported for tests.
export function toolKeyPlan(kind, operation, { id, key, protectedKey, systemRoot = defaultSystemRoot() } = {}) {
  checkId(id);
  if (!operations[operation]) throw new Error('A key store keeps, reads, removes or checks a key.');
  if (operation === 'put') checkKey(key);
  if (kind === 'protected-storage') {
    const program = windowsPowerShell(systemRoot);
    if (operation === 'put')
      return {
        program,
        args: powerShellArgs(protectScript),
        input: Buffer.from(key, 'utf8').toString('base64') + '\n',
      };
    if (operation === 'read') {
      if (typeof protectedKey !== 'string' || !base64.test(protectedKey))
        throw new Error('Reading a protected key needs its protected bytes as base64.');
      return { program, args: powerShellArgs(unprotectScript), input: protectedKey + '\n' };
    }
    return null;
  }
  if (kind === 'keychain') {
    const item = keychainItem(id);
    const command = {
      put: () => {
        if (/[\0\r\n]/.test(key)) throw plain("This computer's Keychain cannot keep a key with a line break.", 400);
        return `add-generic-password -U ${item} -w ${keychainValue(key)}`;
      },
      read: () => `find-generic-password ${item} -w`,
      remove: () => `delete-generic-password ${item}`,
      has: () => `find-generic-password ${item}`,
    }[operation]();
    const input = command + '\n';
    if (Buffer.byteLength(input) > keychainLineBytes)
      throw plain("This computer's Keychain cannot take a key this long through its private input.", 400);
    return { program: '/usr/bin/security', args: ['-i'], input };
  }
  if (kind === 'secret-service') {
    const attributes = ['service', toolKeyService, 'account', id];
    if (operation === 'put')
      return { program: 'secret-tool', args: ['store', `--label=${toolKeyService}`, ...attributes], input: key };
    if (operation === 'remove') return { program: 'secret-tool', args: ['clear', ...attributes], input: '' };
    return { program: 'secret-tool', args: ['lookup', ...attributes], input: '' };
  }
  throw new Error('This key store runs no program.');
}

function defaultSystemRoot() {
  return process.env.SystemRoot || process.env.windir || 'C:\\Windows';
}

// The default runner: the program itself with an argument array, no shell, no window, a short time limit, the input
// on standard input and the answer kept in memory.
export function runToolKeyProgram({ program, args, input }) {
  return spawnSync(program, args, {
    input,
    shell: false,
    windowsHide: true,
    timeout: toolKeyTimeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

const isFile = file => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
// The default finder: the system's own copy for an absolute program, a PATH search otherwise.
const findProgram = program => (path.isAbsolute(program) ? isFile(program) : programOnPath(program));
const outputText = value => (Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : '');

// A key file written whole or not at all, readable only by this user: a fresh file of mode 0600 renamed into place,
// in a folder of mode 0700 (Windows keeps only the read-only flag, and the folder sits in the data folder).
function writePrivate(folder, name, bytes) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  const temporary = path.join(folder, `.${name}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, path.join(folder, name));
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
function readPrivate(file, encoding) {
  try {
    return fs.readFileSync(file, encoding);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
// Runs a file step, turning any failure into the plain message for the operation.
function onFile(operation, step) {
  try {
    return step();
  } catch {
    throw plain(fileFailures[operation]);
  }
}

// The credential store for a data folder's tools. directory is the studio's data folder (store.directory, never an
// attempt's folder); platform, run and find are injected by tests.
export function toolKeyStore({ directory, platform = process.platform, run = runToolKeyProgram, find = findProgram }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    throw new Error("A tool key store needs the studio's data folder.");
  const folder = toolKeysFolder(directory),
    fileOf = (id, extension) => path.join(folder, `${checkId(id)}.${extension}`);
  const found = program => {
    try {
      return !!find(program);
    } catch {
      return false;
    }
  };
  const kind =
    platform === 'win32'
      ? 'protected-storage'
      : platform === 'darwin'
        ? 'keychain'
        : found('secret-tool')
          ? 'secret-service'
          : 'file';

  // Runs one planned program call and returns its exit status and answer; a missing program, a time-out or a runner
  // that fails is refused in the store's words. accepted lists the exit statuses that answer the operation.
  function call(operation, plan, accepted = [0]) {
    const store = stores[kind],
      words = operations[operation];
    if (!found(plan.program)) throw plain(`${store.program} was not found.`);
    let result;
    try {
      result = run(plan);
    } catch {
      throw plain(`${store.name} ${words.refused}.`);
    }
    const code = result?.error?.code;
    if (code === 'ENOENT') throw plain(`${store.program} was not found.`);
    if (code === 'ETIMEDOUT')
      throw plain(`${store.name} did not answer within ${toolKeyTimeout / 1000} seconds, ${words.unfinished}.`);
    if (result?.error || result?.signal || !accepted.includes(result?.status))
      throw plain(`${store.name} ${words.refused}.`);
    return { status: result.status, stdout: outputText(result.stdout), stderr: outputText(result.stderr) };
  }
  const unreadable = operation =>
    plain(`${stores[kind].name} gave an answer the studio could not read, ${operations[operation].unfinished}.`);
  // A key as a program answered it: its one line, without the line break a program adds.
  const answeredKey = text => text.replace(/\r?\n$/, '');

  const backends = {
    'protected-storage': {
      put(id, key) {
        const { stdout } = call('put', toolKeyPlan(kind, 'put', { id, key }));
        const answer = stdout.trim();
        if (!answer || !base64.test(answer)) throw unreadable('put');
        onFile('put', () => writePrivate(folder, `${id}.dpapi`, Buffer.from(answer, 'base64')));
      },
      read(id) {
        const bytes = onFile('read', () => readPrivate(fileOf(id, 'dpapi')));
        if (bytes === null) return null;
        const plan = toolKeyPlan(kind, 'read', { id, protectedKey: bytes.toString('base64') });
        const answer = call('read', plan).stdout.trim();
        if (!base64.test(answer)) throw unreadable('read');
        return Buffer.from(answer, 'base64').toString('utf8');
      },
      remove: id => onFile('remove', () => fs.rmSync(fileOf(id, 'dpapi'), { force: true })),
      has: id => onFile('has', () => fs.existsSync(fileOf(id, 'dpapi'))),
    },
    keychain: {
      put(id, key) {
        call('put', toolKeyPlan(kind, 'put', { id, key }));
      },
      read(id) {
        const { status, stdout } = call('read', toolKeyPlan(kind, 'read', { id }), [0, keychainNotFound]);
        if (status === keychainNotFound) return null;
        // Interactive mode may print its prompt before each command it reads.
        let text = stdout;
        while (text.startsWith('security> ')) text = text.slice('security> '.length);
        const end = text.indexOf('\n');
        return end < 0 ? text : text.slice(0, end).replace(/\r$/, '');
      },
      remove(id) {
        call('remove', toolKeyPlan(kind, 'remove', { id }), [0, keychainNotFound]);
      },
      has: id => call('has', toolKeyPlan(kind, 'has', { id }), [0, keychainNotFound]).status === 0,
    },
    'secret-service': {
      put(id, key) {
        // A key kept in the file before this computer had secret-tool is not left behind.
        onFile('put', () => fs.rmSync(fileOf(id, 'key'), { force: true }));
        call('put', toolKeyPlan(kind, 'put', { id, key }));
      },
      // secret-tool exits 1 both when it has no such key and when it fails; only a failure says why.
      read(id) {
        const { status, stdout, stderr } = call('read', toolKeyPlan(kind, 'read', { id }), [0, 1]);
        if (status === 0) return answeredKey(stdout);
        if (stdout || stderr.trim()) throw plain(`${stores[kind].name} ${operations.read.refused}.`);
        return null;
      },
      remove(id) {
        onFile('remove', () => fs.rmSync(fileOf(id, 'key'), { force: true }));
        call('remove', toolKeyPlan(kind, 'remove', { id }));
      },
      has(id) {
        const { status, stdout, stderr } = call('has', toolKeyPlan(kind, 'has', { id }), [0, 1]);
        if (status === 0) return true;
        if (stdout || stderr.trim()) throw plain(`${stores[kind].name} ${operations.has.refused}.`);
        return false;
      },
    },
    file: {
      put(id, key) {
        onFile('put', () => writePrivate(folder, `${id}.key`, key));
      },
      read: id => onFile('read', () => readPrivate(fileOf(id, 'key'), 'utf8')),
      remove: id => onFile('remove', () => fs.rmSync(fileOf(id, 'key'), { force: true })),
      has: id => onFile('has', () => fs.existsSync(fileOf(id, 'key'))),
    },
  };
  const backend = backends[kind];

  return {
    kind,
    // Only the fallback file is less safe than the system's own credential store.
    lessSafe: kind === 'file',
    // Keeps id's key, replacing any it had.
    put(id, key) {
      checkId(id);
      checkKey(key);
      backend.put(id, key);
    },
    // Removes id's key; removing one that is not kept succeeds.
    remove(id) {
      checkId(id);
      backend.remove(id);
    },
    // Whether a key is kept for id.
    has(id) {
      checkId(id);
      return backend.has(id);
    },
    // id's key, or null when none is kept.
    read(id) {
      checkId(id);
      return backend.read(id);
    },
    // Where id's key is kept: 'protected-storage', 'keychain', 'secret-service' or 'file'.
    where(id) {
      checkId(id);
      return kind;
    },
  };
}
