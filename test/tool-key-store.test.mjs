// A studio tool's key in this computer's own credential store: Windows protected storage through Windows PowerShell,
// the macOS Keychain through security -i, the Linux Secret Service through secret-tool, or a file only this user can
// read when secret-tool is missing. The key reaches a program only on its standard input, failures are plain words
// without the key or a program's output, and nothing reaches the console. Model-free: every program call goes to an
// injected stand-in runner and finder that record what they were given. The real stores are tried by hand on each
// system and are not run in the suite (see the end of this file).
import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  runToolKeyProgram,
  toolKeyPlan,
  toolKeyService,
  toolKeyStore,
  toolKeyTimeout,
  toolKeysFolder,
  toolKeysFolderName,
} from '../src/connectors/tool-key-store.mjs';
import { directorSecretNames } from '../src/director-access.mjs';

// Keys a command line would split, quote or expand.
const keys = [
  'plain-key-0123456789',
  'a key with  spaces ',
  'quotes " double \' single " end',
  'back\\slash\\ and \\" both\\',
  'tab\tdollar $(whoami) `tick` %PATH% ünïcødé',
];
const id = 'tool-6f0c8a52-6c43-4bd4-9f0e-5a3cbd1f2e10';
const systemRoot = 'C:\\Windows';
const kinds = ['protected-storage', 'keychain', 'secret-service'];
const programKinds = { win32: 'protected-storage', darwin: 'keychain', linux: 'secret-service' };

// Everything written to the console while this file's tests run.
const consoleWrites = [];
before(() => {
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'])
    mock.method(console, method, (...values) => consoleWrites.push(values.map(value => String(value)).join(' ')));
});
after(() => mock.restoreAll());

function dataFolder(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tool-keys-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// A stand-in runner that records every call and answers with answer(plan).
function recorder(answer = () => ({ status: 0, stdout: '', stderr: '' })) {
  const calls = [];
  return {
    calls,
    run(plan) {
      calls.push(structuredClone(plan));
      return answer(plan);
    },
  };
}
const findAll = () => true;
const findNone = () => false;

// What a command line shows of a call: its program and arguments.
const commandLine = call => JSON.stringify([call.program, ...call.args]);
const base64Of = key => Buffer.from(key, 'utf8').toString('base64');
function assertKeyOnlyInInput(call, key) {
  for (const shown of [key, base64Of(key)])
    assert.equal(commandLine(call).includes(shown), false, 'the key is never the program or an argument');
}

// The security program's interactive line split: a double quote opens or closes a value, a backslash makes the next
// character plain, and spaces outside quotes separate values.
function splitSecurityLine(line) {
  const values = [];
  let value = null,
    quoted = false;
  for (let at = 0; at < line.length; at++) {
    const character = line[at];
    if (character === '\\') {
      value = (value ?? '') + line[++at];
    } else if (character === '"') {
      quoted = !quoted;
      value ??= '';
    } else if (!quoted && /\s/.test(character)) {
      if (value !== null) values.push(value);
      value = null;
    } else value = (value ?? '') + character;
  }
  if (value !== null) values.push(value);
  return values;
}

// A stand-in for Windows PowerShell's protection: it answers bytes that are not the key, and gives the key back only
// for bytes it made.
function standInProtection() {
  const kept = new Map();
  const protectArgs = toolKeyPlan('protected-storage', 'put', { id, key: 'x', systemRoot }).args;
  const recording = recorder(plan => {
    const input = plan.input.trim();
    if (JSON.stringify(plan.args) === JSON.stringify(protectArgs)) {
      const protectedBytes = Buffer.concat([Buffer.from('stand-in protected '), randomBytes(24)]);
      kept.set(protectedBytes.toString('base64'), input);
      return { status: 0, stdout: protectedBytes.toString('base64') + '\r\n', stderr: '' };
    }
    if (!kept.has(input)) return { status: 1, stdout: '', stderr: 'The data is invalid.' };
    return { status: 0, stdout: kept.get(input), stderr: '' };
  });
  return { ...recording, kept };
}

test('every plan keeps the key out of the program and its arguments, and on standard input only', () => {
  for (const key of keys)
    for (const kind of kinds)
      for (const operation of ['put', 'read', 'remove', 'has']) {
        const plan = toolKeyPlan(kind, operation, {
          id,
          key: operation === 'put' ? key : undefined,
          protectedKey: base64Of('stand-in protected bytes'),
          systemRoot,
        });
        if (!plan) {
          // Windows removes and checks its protected file without a program.
          assert.equal(kind, 'protected-storage');
          assert.ok(['remove', 'has'].includes(operation));
          continue;
        }
        assert.ok(Array.isArray(plan.args));
        assertKeyOnlyInInput(plan, key);
        if (operation !== 'put') {
          assert.equal(plan.input.includes(key), false, `${kind} ${operation} sends no key`);
          continue;
        }
        if (kind === 'protected-storage') assert.equal(Buffer.from(plan.input.trim(), 'base64').toString(), key);
        if (kind === 'secret-service') assert.equal(plan.input, key);
        if (kind === 'keychain') {
          assert.ok(plan.input.endsWith('\n'));
          const values = splitSecurityLine(plan.input.slice(0, -1));
          assert.equal(values[0], 'add-generic-password');
          assert.ok(values.includes('-U'));
          assert.equal(values[values.indexOf('-s') + 1], toolKeyService);
          assert.equal(values[values.indexOf('-a') + 1], id);
          assert.equal(values[values.indexOf('-w') + 1], key, 'spaces, quotes and backslashes survive');
          assert.equal(values.length, 8);
        }
      }
});

test('each system runs its own store program with fixed arguments', () => {
  const put = kind => toolKeyPlan(kind, 'put', { id, key: keys[0], systemRoot });
  const windows = put('protected-storage');
  assert.equal(windows.program, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(windows.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(windows.args[4], 'base64').toString('utf16le');
  assert.match(script, /ProtectedData\]::Protect\(/);
  assert.match(script, /DataProtectionScope\]::CurrentUser/);
  const read = toolKeyPlan('protected-storage', 'read', { id, protectedKey: 'AAAA', systemRoot });
  assert.match(Buffer.from(read.args[4], 'base64').toString('utf16le'), /ProtectedData\]::Unprotect\(/);
  // The same script for every key and tool: the script argument never changes.
  assert.deepEqual(
    toolKeyPlan('protected-storage', 'put', { id: 'tool-2', key: keys[3], systemRoot }).args,
    windows.args,
  );

  assert.deepEqual(put('keychain').args, ['-i']);
  assert.equal(put('keychain').program, '/usr/bin/security');
  const line = operation => splitSecurityLine(toolKeyPlan('keychain', operation, { id }).input.trim());
  assert.deepEqual(line('read'), ['find-generic-password', '-s', toolKeyService, '-a', id, '-w']);
  assert.deepEqual(line('remove'), ['delete-generic-password', '-s', toolKeyService, '-a', id]);
  assert.deepEqual(line('has'), ['find-generic-password', '-s', toolKeyService, '-a', id]);

  const attributes = ['service', toolKeyService, 'account', id];
  assert.deepEqual(put('secret-service'), {
    program: 'secret-tool',
    args: ['store', `--label=${toolKeyService}`, ...attributes],
    input: keys[0],
  });
  assert.deepEqual(toolKeyPlan('secret-service', 'read', { id }).args, ['lookup', ...attributes]);
  assert.deepEqual(toolKeyPlan('secret-service', 'remove', { id }).args, ['clear', ...attributes]);
});

test('put, read and remove on every system never put the key in a recorded program or argument', t => {
  for (const [platform, kind] of Object.entries(programKinds))
    for (const key of keys) {
      const directory = dataFolder(t);
      const recording =
        kind === 'protected-storage'
          ? standInProtection()
          : recorder(plan =>
              plan.args.includes('lookup') || plan.input.startsWith('find-generic-password')
                ? { status: 0, stdout: key + '\n', stderr: '' }
                : { status: 0, stdout: '', stderr: '' },
            );
      const store = toolKeyStore({ directory, platform, run: recording.run, find: findAll });
      assert.equal(store.kind, kind);
      assert.equal(store.lessSafe, false);
      store.put(id, key);
      assert.equal(store.read(id), key, `${kind} gives the key back`);
      store.remove(id);
      assert.ok(recording.calls.length >= 2);
      for (const call of recording.calls) assertKeyOnlyInInput(call, key);
      const [put] = recording.calls;
      if (kind === 'protected-storage') assert.equal(Buffer.from(put.input.trim(), 'base64').toString(), key);
      else if (kind === 'keychain') assert.equal(splitSecurityLine(put.input.trim()).at(-1), key);
      else assert.equal(put.input, key);
    }
});

test('the Windows store leaves only the protected bytes it was given in the data folder', t => {
  const directory = dataFolder(t),
    protection = standInProtection(),
    store = toolKeyStore({ directory, platform: 'win32', run: protection.run, find: findAll });
  const key = keys[2];
  assert.equal(store.where(id), 'protected-storage');
  assert.equal(store.has(id), false);
  assert.equal(store.read(id), null);
  assert.equal(protection.calls.length, 0, 'nothing to unprotect, so no program runs');

  store.put(id, key);
  const folder = toolKeysFolder(directory);
  assert.equal(folder, path.join(directory, toolKeysFolderName));
  assert.ok(directorSecretNames.includes(toolKeysFolderName), 'the folder is one of the secrets every sandbox denies');
  assert.deepEqual(fs.readdirSync(folder), [`${id}.dpapi`]);
  const stored = fs.readFileSync(path.join(folder, `${id}.dpapi`));
  const [made] = protection.kept.keys();
  assert.deepEqual(stored, Buffer.from(made, 'base64'), 'the file holds exactly the stand-in protected bytes');
  for (const form of [key, base64Of(key)]) assert.equal(stored.includes(Buffer.from(form)), false);

  assert.equal(store.has(id), true);
  assert.equal(store.read(id), key);
  assert.equal(protection.calls[1].input.trim(), made, 'reading hands the protected bytes back');

  store.put(id, keys[3]);
  assert.deepEqual(fs.readdirSync(folder), [`${id}.dpapi`], 'a replacement leaves no other file');
  assert.equal(store.read(id), keys[3]);

  const before = protection.calls.length;
  store.remove(id);
  assert.equal(protection.calls.length, before, 'removing deletes the file without a program');
  assert.deepEqual(fs.readdirSync(folder), []);
  assert.equal(store.has(id), false);
  assert.equal(store.read(id), null);
  store.remove(id);
});

test('Linux without secret-tool keeps the key in a file only this user can read, and says it is less safe', t => {
  const directory = dataFolder(t),
    recording = recorder(),
    asked = [],
    store = toolKeyStore({
      directory,
      platform: 'linux',
      run: recording.run,
      find: program => (asked.push(program), false),
    });
  assert.deepEqual(asked, ['secret-tool']);
  assert.equal(store.kind, 'file');
  assert.equal(store.lessSafe, true);
  assert.equal(store.where(id), 'file');
  assert.equal(store.has(id), false);

  store.put(id, keys[4]);
  const folder = toolKeysFolder(directory),
    file = path.join(folder, `${id}.key`);
  assert.deepEqual(fs.readdirSync(folder), [`${id}.key`]);
  assert.equal(fs.readFileSync(file, 'utf8'), keys[4]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  }
  assert.equal(store.has(id), true);
  assert.equal(store.read(id), keys[4]);
  store.put(id, keys[1]);
  assert.equal(store.read(id), keys[1]);
  assert.deepEqual(fs.readdirSync(folder), [`${id}.key`]);
  store.remove(id);
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.read(id), null);
  assert.equal(recording.calls.length, 0, 'the file store runs no program');
});

test('Linux with secret-tool keeps the key in the Secret Service and writes no file', t => {
  const directory = dataFolder(t);
  let kept = null;
  const recording = recorder(plan => {
    const [operation] = plan.args;
    if (operation === 'store') kept = plan.input;
    if (operation === 'clear') kept = null;
    if (operation === 'lookup')
      return kept === null ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: kept };
    return { status: 0, stdout: '', stderr: '' };
  });
  const store = toolKeyStore({ directory, platform: 'linux', run: recording.run, find: findAll });
  assert.equal(store.kind, 'secret-service');
  assert.equal(store.lessSafe, false);
  assert.equal(store.where(id), 'secret-service');
  assert.equal(store.has(id), false);
  assert.equal(store.read(id), null);
  store.put(id, keys[2]);
  assert.equal(fs.existsSync(toolKeysFolder(directory)), false, 'no file is written');
  assert.equal(store.has(id), true);
  assert.equal(store.read(id), keys[2]);
  store.remove(id);
  assert.equal(store.read(id), null);
  assert.equal(fs.existsSync(toolKeysFolder(directory)), false);

  // A key kept in the file before this computer had secret-tool is removed when the key is set again.
  fs.mkdirSync(toolKeysFolder(directory));
  fs.writeFileSync(path.join(toolKeysFolder(directory), `${id}.key`), 'an older key');
  store.put(id, keys[0]);
  assert.deepEqual(fs.readdirSync(toolKeysFolder(directory)), []);
});

test('a found secret-tool that fails is refused in words, never replaced by the file', t => {
  const directory = dataFolder(t),
    recording = recorder(() => ({ status: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' })),
    store = toolKeyStore({ directory, platform: 'linux', run: recording.run, find: findAll });
  assert.throws(() => store.put(id, keys[0]), { message: "This computer's Secret Service refused to keep the key." });
  assert.throws(() => store.read(id), { message: "This computer's Secret Service refused to give the key back." });
  assert.throws(() => store.has(id), {
    message: "This computer's Secret Service could not say whether it keeps the key.",
  });
  assert.throws(() => store.remove(id), { message: "This computer's Secret Service refused to remove the key." });
  assert.equal(store.kind, 'secret-service');
  assert.equal(fs.existsSync(toolKeysFolder(directory)), false);
});

test('the Keychain reads past its prompt, and a key it does not have reads as none', t => {
  const directory = dataFolder(t);
  for (const stdout of ['security> the key\nsecurity> ', 'the key\n', 'the key'])
    assert.equal(
      toolKeyStore({ directory, platform: 'darwin', run: () => ({ status: 0, stdout }), find: findAll }).read(id),
      'the key',
    );
  const missing = toolKeyStore({
    directory,
    platform: 'darwin',
    run: () => ({ status: 44, stdout: '' }),
    find: findAll,
  });
  assert.equal(missing.read(id), null);
  assert.equal(missing.has(id), false);
  missing.remove(id);
  const present = toolKeyStore({
    directory,
    platform: 'darwin',
    run: () => ({ status: 0, stdout: '' }),
    find: findAll,
  });
  assert.equal(present.has(id), true);
  assert.equal(present.where(id), 'keychain');
});

test('the Keychain refuses a key its command line cannot carry, before any program runs', t => {
  const directory = dataFolder(t),
    recording = recorder(),
    store = toolKeyStore({ directory, platform: 'darwin', run: recording.run, find: findAll });
  const broken = 'first line\nsecond line';
  assert.throws(
    () => store.put(id, broken),
    error => error.message === "This computer's Keychain cannot keep a key with a line break." && error.status === 400,
  );
  assert.throws(() => store.put(id, 'k'.repeat(4096)), {
    message: "This computer's Keychain cannot take a key this long through its private input.",
  });
  assert.equal(recording.calls.length, 0);
});

test('a key that is not text and a name that is not a tool ID are refused before any program runs', t => {
  const directory = dataFolder(t);
  for (const platform of ['win32', 'darwin', 'linux']) {
    const recording = recorder(),
      store = toolKeyStore({ directory, platform, run: recording.run, find: findAll });
    for (const key of [undefined, null, 1234, Buffer.from('key'), { key: 'x' }])
      assert.throws(() => store.put(id, key), { message: "A tool's key must be text." });
    for (const name of ['../tool-1', 'tool-1/../../x', 'tool-', 'con', '', 7, 'tool-a b', 'tool-"x"'])
      for (const operation of ['put', 'read', 'remove', 'has', 'where'])
        assert.throws(() => store[operation](name, 'a key'), {
          message: "A tool's key is kept only under the tool's ID.",
        });
    assert.equal(recording.calls.length, 0);
  }
  assert.throws(() => toolKeyStore({ directory: 'relative/data' }), /data folder/);
  assert.equal(fs.existsSync(toolKeysFolder(directory)), false);
});

// Every way a store's program fails: missing, refusing, too slow, throwing, and echoing what it was given.
const timedOut = () => ({
  status: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  error: Object.assign(new Error('spawnSync secret-tool ETIMEDOUT'), { code: 'ETIMEDOUT' }),
});
const failures = {
  'a missing program': { find: findNone, run: () => ({ status: 0, stdout: '' }) },
  'a program that vanished before it ran': {
    run: plan => ({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error(`spawnSync ${plan.program} ENOENT`), { code: 'ENOENT' }),
    }),
  },
  'a refusing program': { run: () => ({ status: 5, stdout: '', stderr: 'Access is denied.' }) },
  'a time-out': { run: timedOut },
  'a runner that throws': {
    run: plan => {
      throw new Error(`could not start: ${plan.input}`);
    },
  },
  'a program that echoes its input': {
    run: plan => ({
      status: 1,
      stdout: `you sent ${plan.input}`,
      stderr: `echo: ${plan.input} ${plan.args.join(' ')}`,
    }),
  },
};
const storeWords = {
  'protected-storage':
    /^(This user's protected storage|Windows PowerShell, which keeps keys in this user's protected storage,) /,
  keychain: /^(This computer's Keychain|The security program, which keeps keys in this computer's Keychain,) /,
  'secret-service':
    /^(This computer's Secret Service|The secret-tool program, which keeps keys in this computer's Secret Service,) /,
};

test('a missing, refusing, slow or echoing program gives a plain message without the key or its output', t => {
  const directory = dataFolder(t);
  const key = keys[2] + ' unique-' + randomUUID();
  for (const [platform, kind] of Object.entries(programKinds))
    for (const [failure, { find = findAll, run }] of Object.entries(failures)) {
      // Linux without secret-tool keeps the key in its file (tested above), so its missing program is the one that
      // vanished after the store found it.
      if (platform === 'linux' && failure === 'a missing program') continue;
      const seen = [];
      const runner = plan => {
        seen.push(plan);
        return run(plan);
      };
      const store = toolKeyStore({ directory, platform, run: runner, find });
      // A Windows read needs a protected file to hand to the program.
      fs.mkdirSync(toolKeysFolder(directory), { recursive: true });
      fs.writeFileSync(path.join(toolKeysFolder(directory), `${id}.dpapi`), 'stand-in protected bytes');
      for (const operation of ['put', 'read', 'remove', 'has']) {
        if (kind === 'protected-storage' && ['remove', 'has'].includes(operation)) continue;
        let error;
        try {
          store[operation](id, key);
        } catch (thrown) {
          error = thrown;
        }
        assert.ok(error instanceof Error, `${kind} ${operation} with ${failure} is refused`);
        const { message } = error;
        assert.match(message, storeWords[kind], `${kind} ${operation} with ${failure} names its store: ${message}`);
        assert.match(message, /^[A-Z][^\n]*\.$/, 'one plain sentence');
        if (failure === 'a time-out') assert.match(message, new RegExp(`within ${toolKeyTimeout / 1000} seconds`));
        if (failure.startsWith('a missing') || failure.includes('vanished')) assert.match(message, / was not found\.$/);
        for (const hidden of [
          key,
          base64Of(key),
          'Access is denied',
          'you sent',
          'echo:',
          'ETIMEDOUT',
          'ENOENT',
          'could not start',
          directory,
          os.tmpdir(),
        ])
          assert.equal(message.includes(hidden), false, `${kind} ${operation} with ${failure} leaves out ${hidden}`);
        for (const plan of seen) assertKeyOnlyInInput(plan, key);
      }
      assert.equal(seen.length > 0, failure !== 'a missing program', 'a program that is not found never runs');
      // A failed put leaves nothing new in the data folder.
      assert.deepEqual(fs.readdirSync(toolKeysFolder(directory)), [`${id}.dpapi`]);
    }
});

test('an answer the Windows store cannot read keeps nothing', t => {
  const directory = dataFolder(t),
    store = toolKeyStore({
      directory,
      platform: 'win32',
      run: () => ({ status: 0, stdout: 'not base64!' }),
      find: findAll,
    });
  assert.throws(() => store.put(id, keys[0]), {
    message: "This user's protected storage gave an answer the studio could not read, so the key was not kept.",
  });
  assert.equal(fs.existsSync(toolKeysFolder(directory)), false);
});

test('the default runner passes the key only on standard input, with no shell, no window and a time limit', t => {
  const seen = [];
  const spawn = mock.method(childProcess, 'spawnSync', (program, args, options) => {
    seen.push({ program, args, options });
    return { status: 0, stdout: '', stderr: '' };
  });
  syncBuiltinESMExports();
  try {
    runToolKeyProgram(toolKeyPlan('secret-service', 'put', { id, key: keys[1] }));
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(seen.length, 1);
  const [{ program, args, options }] = seen;
  assert.equal(program, 'secret-tool');
  assert.ok(Array.isArray(args));
  assertKeyOnlyInInput({ program, args }, keys[1]);
  assert.equal(options.input, keys[1]);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, toolKeyTimeout);
  assert.equal(toolKeyTimeout, 15000);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);

  // A real program gets the key on its standard input, and its answer stays in memory.
  const echoed = runToolKeyProgram({
    program: process.execPath,
    args: ['-e', 'process.stdin.pipe(process.stdout)'],
    input: keys[4],
  });
  assert.equal(echoed.status, 0);
  assert.equal(echoed.stdout, keys[4]);
});

test('nothing is written to the console while the stores work', () => {
  assert.deepEqual(consoleWrites, []);
});

// The real stores, which keep the key in this computer's own credential store and so are not run in the suite. To try
// one by hand on its system, set STUDIO_DESK_REAL_KEY_STORES=1 and run this file there; it keeps, reads, replaces and
// removes a key for a throwaway tool ID and leaves nothing behind.
const realStores = [
  [
    'win32',
    'the real Windows protected storage keeps, replaces, reads and removes a key (not run in the suite; tried by hand on Windows)',
  ],
  [
    'darwin',
    'the real macOS Keychain keeps, replaces, reads and removes a key (not run in the suite; tried by hand on macOS)',
  ],
  [
    'linux',
    'the real Linux Secret Service keeps, replaces, reads and removes a key (not run in the suite; tried by hand on Linux)',
  ],
];
for (const [platform, name] of realStores)
  if (process.env.STUDIO_DESK_REAL_KEY_STORES === '1' && process.platform === platform)
    test(name, t => {
      const directory = dataFolder(t),
        store = toolKeyStore({ directory }),
        tool = 'tool-hand-check-' + randomUUID(),
        first = 'hand check "quoted" \\ key ' + randomUUID(),
        second = 'replaced key ' + randomUUID();
      assert.equal(store.kind, programKinds[platform]);
      try {
        store.put(tool, first);
        assert.equal(store.has(tool), true);
        assert.equal(store.read(tool), first);
        store.put(tool, second);
        assert.equal(store.read(tool), second);
      } finally {
        store.remove(tool);
      }
      assert.equal(store.has(tool), false);
      assert.equal(store.read(tool), null);
    });
