// The built-in sandbox (1.0.1): Anthropic's sandbox runtime, run as a program of its own, where candidate tests
// and an idea's checks run once it is set up on this computer. Model-free: the sandbox itself is never started
// here; its setup and status are fakes, and the commands are checked as recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { setup } from './source-story-setup.mjs';
import {
  builtInSandbox,
  builtInSandboxCommand,
  builtInSandboxCommandLine,
  builtInSandboxDataFolder,
  builtInSandboxDataSecrets,
  builtInSandboxEnvironment,
  builtInSandboxRunArguments,
  builtInSandboxRunUsage,
  builtInSandboxRunner,
  builtInSandboxRuntimeEnvironment,
  builtInSandboxSecrets,
  builtInSandboxSessionWaitMs,
  builtInSandboxSettings,
  builtInSandboxState,
  builtInSandboxVersion,
  dataDenyDone,
  dataDenyLock,
  dataDenyTimeoutMs,
  denyBuiltInSandboxData,
  denyBuiltInSandboxDataFolders,
  denyBuiltInSandboxSecrets,
  readBuiltInSandboxStatus,
  takeBuiltInSandboxSession,
} from '../src/adapters/built-in-sandbox.mjs';
import { checkSeconds } from '../src/packs/studio-development/index.mjs';
import { repositoryTestSeconds } from '../src/connectors/source-projects.mjs';
import { testTimeoutMs } from '../src/connectors/source-integration.mjs';

test("the computer's built-in sandbox sessions are taken in turn, an ended holder's slot freed, and a waiter told once", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-sessions-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const live = new Set([101, 102, 103]),
    take = (pid, extra = {}) =>
      takeBuiltInSandboxSession(folder, { slots: 2, pid, alive: holder => live.has(holder), waitMs: 20, ...extra });
  const first = await take(101),
    second = await take(102);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['slot-0.lock', 'slot-1.lock']);
  // A third waits while both are taken, is told so once, and takes the slot given back.
  const waits = [];
  let third = null;
  const taking = take(103, { onWait: slots => waits.push(slots) }).then(release => (third = release));
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(third, null, 'still waiting');
  assert.deepEqual(waits, [2]);
  first();
  await taking;
  assert.equal(typeof third, 'function');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, 103);
  // Giving back is a holder's own: an old release leaves the slot's new holder alone.
  first();
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, 103);
  // A holder that ended without giving back (stopped hard) frees its slot.
  live.delete(102);
  const fourth = await take(104);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-1.lock'), 'utf8')).pid, 104);
  second();
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-1.lock'), 'utf8')).pid, 104);
  third();
  fourth();
  assert.deepEqual(fs.readdirSync(folder), []);
});

// A slot as a run writes it: its holder's ID and when it took the slot, after the holder started.
const writeSlot = (folder, slot, pid, since) =>
  fs.writeFileSync(path.join(folder, `slot-${slot}.lock`), JSON.stringify({ pid, since }));
const sessionFolder = t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-sessions-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
};

test('a slot whose ID now belongs to a process started after the slot was taken is freed for the next run', async t => {
  const folder = sessionFolder(t),
    since = '2026-11-01T08:00:00.000Z',
    asked = [];
  // This test's own process is alive and answers its ID, but the start time read says it started a day after the slot.
  writeSlot(folder, 0, process.pid, since);
  const release = await takeBuiltInSandboxSession(folder, {
    slots: 1,
    pid: 4242,
    waitMs: 10,
    waitBoundMs: 2000,
    readStartTime: holder => (asked.push(holder), new Date('2026-11-02T08:00:00.000Z')),
  });
  assert.deepEqual(asked, [process.pid]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, 4242);
  release();
  assert.deepEqual(fs.readdirSync(folder), []);
});

test('a slot whose live holder started before the slot was taken stays taken, its start time read once', async t => {
  const folder = sessionFolder(t),
    since = new Date().toISOString();
  let reads = 0;
  writeSlot(folder, 0, process.pid, since);
  let taken = null;
  const taking = takeBuiltInSandboxSession(folder, {
    slots: 1,
    pid: 4243,
    waitMs: 10,
    waitBoundMs: 5000,
    readStartTime: () => (reads++, new Date(Date.parse(since) - 60000)),
  }).then(release => (taken = release));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(taken, null, 'still waiting');
  assert.equal(reads, 1, 'asked once across several passes');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, process.pid);
  // The holder gives its slot back, and the waiter takes it.
  fs.rmSync(path.join(folder, 'slot-0.lock'));
  await taking;
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'slot-0.lock'), 'utf8')).pid, 4243);
  taken();
});

test('a run that finds every session held by runs still going stops after its wait bound, saying so, and changes no slot', async t => {
  const folder = sessionFolder(t),
    since = new Date().toISOString(),
    slotFiles = () => fs.readdirSync(folder).map(name => [name, fs.readFileSync(path.join(folder, name), 'utf8')]);
  writeSlot(folder, 0, process.pid, since);
  writeSlot(folder, 1, process.pid, new Date(Date.parse(since) + 1).toISOString());
  const before = slotFiles(),
    waits = [];
  let reads = 0;
  const begun = Date.now();
  await assert.rejects(
    takeBuiltInSandboxSession(folder, {
      slots: 2,
      pid: 4244,
      waitMs: 10,
      waitBoundMs: 120,
      onWait: slots => waits.push(slots),
      readStartTime: () => (reads++, new Date(Date.parse(since) - 60000)),
    }),
    error =>
      /^All 2 of this computer's built-in sandbox sessions stayed in use by runs still going, so this run stopped after waiting [\d.]+ seconds? for one\.$/.test(
        error.message,
      ),
  );
  assert.ok(Date.now() - begun >= 120, 'waited out its bound');
  assert.equal(reads, 2, 'each holder asked once');
  assert.deepEqual(waits, [2]);
  assert.deepEqual(slotFiles(), before);
  // A run that waits out the bound still has half its own time limit left to say why, for every sandboxed run: an
  // idea's checks, a repository's tests, and candidate tests and integration (their tests' share of the limit).
  const shortestMs = Math.min(checkSeconds * 1000, repositoryTestSeconds * 1000, testTimeoutMs);
  assert.ok(
    builtInSandboxSessionWaitMs * 2 <= shortestMs,
    `${builtInSandboxSessionWaitMs} ms against ${shortestMs} ms`,
  );
});

test("before a Windows run the director's key and launch link above the copy are denied to the sandbox group, or the run stops", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-secrets-')),
    root = path.join(directory, 'data', 'projects', 'p', 'jobs', 'a', 'copy');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(builtInSandboxSecrets(root), [], 'a data folder without a key has nothing to deny');
  const key = path.join(directory, 'data', 'director-key');
  fs.writeFileSync(key, 'a'.repeat(64));
  assert.deepEqual(builtInSandboxSecrets(root), [key]);
  // The launch link beside it sets the director's session cookie, so it is denied as the key is.
  const launch = path.join(directory, 'data', 'launch-url');
  fs.writeFileSync(launch, 'http://127.0.0.1:4317/launch/' + 'c'.repeat(48));
  assert.deepEqual(builtInSandboxSecrets(root), [key, launch]);
  fs.rmSync(launch);
  const calls = [];
  denyBuiltInSandboxSecrets([key], (program, args) => (calls.push([program, args]), { status: 0 }));
  assert.deepEqual(calls, [['icacls', [key, '/deny', 'sandbox-runtime-users:(R)']]]);
  assert.throws(
    () => denyBuiltInSandboxSecrets([key], () => ({ status: 5, stderr: 'Access is denied.' })),
    /could not be kept from the director's sign-in file .*Access is denied/,
  );
  // The tools' keys are a folder: its entry reaches every key in it.
  const toolKeys = path.join(directory, 'data', 'tool-keys');
  fs.mkdirSync(toolKeys);
  assert.deepEqual(builtInSandboxSecrets(root), [key, toolKeys]);
  calls.length = 0;
  denyBuiltInSandboxSecrets([key, toolKeys], (program, args) => (calls.push([program, args]), { status: 0 }));
  assert.deepEqual(calls, [
    ['icacls', [key, '/deny', 'sandbox-runtime-users:(R)']],
    ['icacls', [toolKeys, '/deny', 'sandbox-runtime-users:(OI)(CI)(R)']],
  ]);
});

test('before a Windows run the rest of the data folder is denied to the sandbox group, its copy let back in by its grant', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-data-')),
    data = path.join(directory, 'data'),
    root = path.join(data, 'projects', 'p', 'jobs', 'a', 'copy');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  assert.equal(builtInSandboxDataFolder(root), null, 'a copy outside any data folder has none to deny');
  const { calls, run } = fakeAccessList(),
    outside = { run, profile: path.join(directory, 'home') };
  assert.equal(denyBuiltInSandboxData(null, outside), null);
  assert.deepEqual(calls, []);
  fs.writeFileSync(path.join(data, 'director-key'), 'a'.repeat(64));
  assert.equal(builtInSandboxDataFolder(root), data);
  // Reading what anything in it holds, its own listing included; looking at a folder stays allowed, as Node looks at
  // each folder on the way to the copy. Set once, with as long as Windows takes to write it to everything in the folder.
  assert.equal(denyBuiltInSandboxData(data, outside), data);
  assert.deepEqual(calls, [['icacls', [data, '/deny', 'sandbox-runtime-users:(OI)(CI)(RD)'], dataDenyTimeoutMs]]);
  assert.ok(fs.existsSync(path.join(data, dataDenyDone)), 'the finished writing is recorded');
  assert.ok(!fs.existsSync(path.join(data, dataDenyLock)), 'and the lock given back');
  // After that a run reads only the folder's own list, which is quick (November 3: every run failed at 30 seconds).
  calls.length = 0;
  assert.equal(denyBuiltInSandboxData(data, outside), data);
  assert.deepEqual(calls, [['icacls', [data], 30000]]);
  // A writing cut short leaves the folder's own entry without the record, and is done again.
  fs.rmSync(path.join(data, dataDenyDone));
  calls.length = 0;
  assert.equal(denyBuiltInSandboxData(data, outside), data);
  assert.deepEqual(
    calls.map(([, args]) => args[1] ?? 'read'),
    ['/deny'],
  );
  // Inside the director's profile nothing is read or set: the profile's permissions keep the sandbox account out.
  calls.length = 0;
  assert.equal(denyBuiltInSandboxData(data, { run, profile: directory }), null);
  assert.equal(
    denyBuiltInSandboxData(data, { run, profile: data.toUpperCase() }),
    null,
    'the profile itself, in any case',
  );
  assert.deepEqual(calls, []);
  // A failure stops the run, records nothing and gives the lock back.
  fs.rmSync(path.join(data, dataDenyDone));
  assert.throws(
    () => denyBuiltInSandboxData(data, { ...outside, run: () => ({ status: 5, stderr: 'Access is denied.' }) }),
    /could not be kept from the data folder .*Access is denied/,
  );
  assert.ok(!fs.existsSync(path.join(data, dataDenyDone)) && !fs.existsSync(path.join(data, dataDenyLock)));
});

// A fake icacls: the folder's own list holds the data deny once it has been set, or from a given read on.
function fakeAccessList({ deniedFromRead = Infinity } = {}) {
  const calls = [];
  let set = false,
    reads = 0;
  const run = (program, args, options) => {
    calls.push([program, args, options.timeout]);
    if (args[1] === '/deny') set = true;
    else reads++;
    const entry = set || reads >= deniedFromRead ? 'PC\\sandbox-runtime-users:(OI)(CI)(DENY)(RD)\n ' : '';
    return { status: 0, stdout: `${args[0]} ${entry}BUILTIN\\Administrators:(I)(OI)(CI)(F)\n` };
  };
  return { calls, run };
}

test("a Windows run that finds another writing the data folder's deny waits for it, takes over an ended run's lock, and stops when it is held too long", t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-data-lock-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const lock = path.join(data, dataDenyLock),
    profile = path.join(data, '..', 'elsewhere'),
    holdLock = pid => fs.writeFileSync(lock, JSON.stringify({ pid }));
  // A live run holds the lock, and its writing finishes while this one waits: nothing is set twice.
  holdLock(process.pid);
  fs.writeFileSync(path.join(data, dataDenyDone), 'x');
  let fake = fakeAccessList({ deniedFromRead: 3 });
  assert.equal(denyBuiltInSandboxData(data, { run: fake.run, profile, waitMs: 5 }), data);
  assert.deepEqual(
    fake.calls.map(([, args]) => args[1] ?? 'read'),
    ['read', 'read', 'read'],
  );
  assert.ok(fs.existsSync(lock), "the other run's lock is left to it");
  // A lock left by a run that ended is taken over.
  fs.rmSync(path.join(data, dataDenyDone));
  holdLock(spawnSync(process.execPath, ['-e', '']).pid);
  fake = fakeAccessList();
  assert.equal(denyBuiltInSandboxData(data, { run: fake.run, profile, waitMs: 5 }), data);
  assert.deepEqual(
    fake.calls.map(([, args]) => args[1] ?? 'read'),
    ['/deny'],
  );
  assert.ok(!fs.existsSync(lock));
  // A live lock held past the time limit stops the run rather than leaving the folder readable.
  fs.rmSync(path.join(data, dataDenyDone));
  holdLock(process.pid);
  assert.throws(
    () => denyBuiltInSandboxData(data, { run: fakeAccessList().run, profile, timeoutMs: 30, waitMs: 5 }),
    /could not be kept from the data folder .*held its lock too long/,
  );
});

const claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url)),
  plan = { root: '/candidate', command: { executable: process.execPath, args: ['--test', 'test/a.test.mjs'] } };
// A fake for the controller's view of the sandbox: its state and a setup that finishes when told to.
function fakeSandbox(state) {
  const sandbox = {
    state,
    setups: 0,
    finish: null,
    status: () => ({ state: sandbox.state }),
    setup(done) {
      if (!['not-set-up', 'outdated'].includes(sandbox.state)) return false;
      sandbox.setups++;
      sandbox.finish = next => {
        sandbox.state = next;
        done({ state: next });
      };
      return true;
    },
  };
  return sandbox;
}

test('its tests run through its runner, which gets the folder they may write and the plan’s command', () => {
  // test-sandbox.test.mjs covers which attempts run here and what they record.
  assert.deepEqual(builtInSandboxCommand(plan), {
    executable: process.execPath,
    args: [builtInSandboxRunner, '--root', '/candidate', '--', process.execPath, '--test', 'test/a.test.mjs'],
  });
  // The controller's own data folder, which the run is kept from wherever the copy is, goes after the copy.
  assert.deepEqual(builtInSandboxCommand({ ...plan, data: '/data' }), {
    executable: process.execPath,
    args: [
      builtInSandboxRunner,
      '--root',
      '/candidate',
      '--data',
      '/data',
      '--',
      process.execPath,
      '--test',
      'test/a.test.mjs',
    ],
  });
});

test('the runner reads its arguments with or without the data folder, and refuses any other list with its usage line', () => {
  assert.deepEqual(builtInSandboxRunArguments(['--root', '/c', '--data', '/d', '--', 'node', '--test', 'a.mjs']), {
    root: '/c',
    data: '/d',
    executable: 'node',
    args: ['--test', 'a.mjs'],
  });
  // A command recorded on an attempt before the data folder was named keeps running.
  assert.deepEqual(builtInSandboxRunArguments(['--root', '/c', '--', 'node']), {
    root: '/c',
    data: null,
    executable: 'node',
    args: [],
  });
  // An argument after the separator is the command's own, however it looks.
  assert.deepEqual(builtInSandboxRunArguments(['--root', '/c', '--', 'node', '--data', '/x']).args, ['--data', '/x']);
  for (const malformed of [
    [],
    ['--root'],
    ['--root', '/c'],
    ['--root', '/c', '--'],
    ['--root', '--', 'node'],
    ['--data', '/d', '--root', '/c', '--', 'node'],
    ['--root', '/c', '--data', '--', 'node'],
    ['--root', '/c', '--data', '/d', '--'],
    ['--root', '/c', '--data', '/d', 'node'],
    ['--root', '/c', '--other', '/d', '--', 'node'],
    ['--root', '/c', '--data', '/d', '--data', '/e', '--', 'node'],
  ])
    assert.equal(builtInSandboxRunArguments(malformed), null, malformed.join(' '));
  // The runner itself stops there, before it prepares or starts anything.
  const refused = spawnSync(process.execPath, [builtInSandboxRunner, '--root', '/c', '--data', '--', 'node'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(refused.status, 2);
  assert.equal(refused.stderr.trim(), builtInSandboxRunUsage);
});

test("on macOS and Linux the controller's named data folder and its secrets are denied wherever the copy is", t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-named-data-'))),
    root = path.join(directory, 'source', '.studio-verify', 'wt', 'v-1'),
    data = path.join(directory, 'moved-data'),
    home = path.join(directory, 'home');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  const run = {
      root,
      nodeDirectory: path.join(directory, 'node'),
      launcherDirectory: path.join(directory, 'adapters'),
      runDirectory: path.join(directory, 'run'),
      helper: path.join(directory, 'srt-win.exe'),
      seccomp: path.join(directory, 'seccomp'),
      temporary: path.join(directory, 'run', 'tmp'),
      platform: 'linux',
      home,
    },
    today = builtInSandboxSettings(run);
  // A named folder that is not there (a source whose controller never ran) changes nothing.
  assert.deepEqual(builtInSandboxSettings({ ...run, data }), today);
  fs.mkdirSync(data);
  const key = path.join(data, 'director-key'),
    launch = path.join(data, 'launch-url');
  fs.writeFileSync(key, 'a'.repeat(64));
  fs.writeFileSync(launch, 'http://127.0.0.1:4317/launch/' + 'c'.repeat(48));
  assert.deepEqual(builtInSandboxDataSecrets(data), [key, launch]);
  assert.equal(builtInSandboxDataFolder(root), null, 'the copy is outside the data folder');
  const named = builtInSandboxSettings({ ...run, data });
  assert.deepEqual(named.filesystem.denyRead, [home, data, key, launch]);
  assert.ok(named.filesystem.allowRead.includes(root), 'the copy is still read');
  assert.deepEqual(named.filesystem.allowRead, today.filesystem.allowRead);
  assert.deepEqual(named.filesystem.allowWrite, [root, run.temporary]);
  // Without a named folder the settings are as they were.
  assert.deepEqual(builtInSandboxSettings(run).filesystem.denyRead, [home]);
  // A copy inside the named folder names it once, and keeps its own grants.
  const inside = path.join(data, 'projects', 'p', 'jobs', 'a', 'copy');
  fs.mkdirSync(inside, { recursive: true });
  const within = builtInSandboxSettings({ ...run, root: inside, data });
  assert.deepEqual(within.filesystem.denyRead, [home, data, key, launch]);
  assert.equal(within.filesystem.allowRead[0], inside);
  assert.deepEqual(within.filesystem.allowWrite, [inside, run.temporary]);
  // Windows' account is kept out before the run instead (below); its settings list nothing to deny.
  assert.deepEqual(builtInSandboxSettings({ ...run, data, platform: 'win32' }).filesystem.denyRead, []);
});

test("before a Windows run the controller's named data folder and its secrets are denied wherever the copy is, the folder not in the profile", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-named-data-')),
    root = path.join(directory, 'source', '.studio-verify', 'wt', 'v-1'),
    data = path.join(directory, 'data'),
    profile = path.join(directory, 'home');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(data);
  const key = path.join(data, 'director-key'),
    launch = path.join(data, 'launch-url');
  fs.writeFileSync(key, 'a'.repeat(64));
  fs.writeFileSync(launch, 'http://127.0.0.1:4317/launch/' + 'c'.repeat(48));
  const prepare = (copy, named, home = profile) => {
    const { calls, run } = fakeAccessList();
    const result = denyBuiltInSandboxDataFolders(copy, named, { run, profile: home });
    return { result, calls: calls.map(([program, args]) => [program, args]) };
  };
  // Without a named folder, a copy outside any data folder has nothing to deny, as before.
  assert.deepEqual(prepare(root, null).calls, []);
  // Named, its key and launch link are denied and then the folder itself.
  let prepared = prepare(root, data);
  assert.deepEqual(prepared.calls, [
    ['icacls', [key, '/deny', 'sandbox-runtime-users:(R)']],
    ['icacls', [launch, '/deny', 'sandbox-runtime-users:(R)']],
    ['icacls', [data, '/deny', 'sandbox-runtime-users:(OI)(CI)(RD)']],
  ]);
  assert.deepEqual(prepared.result, { secrets: [key, launch], folders: [data] });
  // Inside the director's profile the folder gets no deny (the profile keeps the sandbox account out); its secrets
  // are denied as those above a copy always were.
  fs.rmSync(path.join(data, dataDenyDone));
  prepared = prepare(root, data, directory);
  assert.deepEqual(prepared.calls, [
    ['icacls', [key, '/deny', 'sandbox-runtime-users:(R)']],
    ['icacls', [launch, '/deny', 'sandbox-runtime-users:(R)']],
  ]);
  assert.deepEqual(prepared.result, { secrets: [key, launch], folders: [null] });
  // A copy inside the named folder has it denied once, as without the name.
  const inside = path.join(data, 'projects', 'p', 'jobs', 'a', 'copy');
  fs.mkdirSync(inside, { recursive: true });
  const before = prepare(inside, null).calls;
  assert.deepEqual(
    before.map(([, args]) => args[0]),
    [key, launch, data],
  );
  fs.rmSync(path.join(data, dataDenyDone));
  assert.deepEqual(prepare(inside, data).calls, before);
  // A named folder that is not there changes nothing.
  assert.deepEqual(prepare(root, path.join(directory, 'missing')).calls, []);
});

test("the runtime's status reads as not set up, out of date or ready", () => {
  // As the runtime's helper printed it on a computer where it had never been set up (October 25).
  const fresh = {
    user: {
      cred_present: false,
      marker_version: null,
      setup_version: 3,
      user: { exists: false, name: 'srt-sandbox' },
    },
    wfp: { state: 'cannot-read' },
  };
  assert.deepEqual(builtInSandboxState(fresh), { state: 'not-set-up' });
  const installed = structuredClone(fresh);
  Object.assign(installed.user, { cred_present: true, marker_version: 3 });
  installed.user.user.exists = true;
  assert.deepEqual(builtInSandboxState(installed), { state: 'ready' });
  installed.user.marker_version = 2;
  assert.deepEqual(builtInSandboxState(installed), { state: 'outdated' }, 'Set up by another release.');
  assert.deepEqual(builtInSandboxState(undefined), { state: 'not-set-up' });
});

test('the status is read from the runtime’s helper, and a copy without the packages says so', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-built-in-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = { cli: path.join(directory, 'cli.js'), srtWin: path.join(directory, 'srt-win.exe') },
    windows = { platform: 'win32' };
  assert.deepEqual(readBuiltInSandboxStatus(files, undefined, windows), { state: 'missing' });
  for (const file of Object.values(files)) fs.writeFileSync(file, '');
  const calls = [];
  const reply = stdout => (binary, args) => (calls.push([binary, args]), { stdout, stderr: '' });
  const ready = { user: { cred_present: true, marker_version: 3, setup_version: 3, user: { exists: true } } };
  assert.deepEqual(readBuiltInSandboxStatus(files, reply(JSON.stringify(ready)), windows), { state: 'ready' });
  assert.deepEqual(calls[0], [files.srtWin, ['status']]);
  assert.equal(readBuiltInSandboxStatus(files, reply('not json'), windows).state, 'not-set-up');
  assert.deepEqual(readBuiltInSandboxStatus(files, undefined, { platform: 'freebsd' }), { state: 'unsupported' });
});

test('macOS needs nothing set up, and Linux names the packages it needs and how to install them', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-built-in-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = { cli: path.join(directory, 'cli.js'), srtWin: path.join(directory, 'srt-win.exe') },
    finds = programs => program => (programs.includes(program) ? `/usr/bin/${program}` : null),
    noHelper = () => assert.fail('Only Windows asks the helper.');
  // macOS's sandbox is part of the system, so a copy with the packages is ready.
  const mac = { platform: 'darwin', find: finds(['sandbox-exec']) };
  assert.deepEqual(readBuiltInSandboxStatus(files, noHelper, mac), { state: 'missing' }, 'npm ci first.');
  fs.writeFileSync(files.cli, '');
  assert.deepEqual(readBuiltInSandboxStatus(files, noHelper, mac), { state: 'ready' });
  // Linux: the programs it lacks, by package, installed by the first package manager found.
  const linux = (programs, environment = {}) =>
    readBuiltInSandboxStatus(files, noHelper, { platform: 'linux', find: finds(programs), environment });
  assert.deepEqual(linux(['bwrap', 'socat', 'rg']), { state: 'ready' });
  assert.deepEqual(linux(['bwrap', 'apt-get']), {
    state: 'not-set-up',
    needs: ['socat', 'ripgrep'],
    command: 'sudo apt-get install -y socat ripgrep',
    prompt: false,
  });
  assert.equal(linux(['pacman']).command, 'sudo pacman -S --needed --noconfirm bubblewrap socat ripgrep');
  assert.equal(linux(['dnf', 'pkexec']).prompt, false, 'pkexec shows its prompt only in a desktop session.');
  assert.equal(linux(['dnf', 'pkexec'], { XDG_CURRENT_DESKTOP: 'GNOME' }).prompt, true);
  assert.deepEqual(linux(['pkexec'], { XDG_CURRENT_DESKTOP: 'GNOME' }), {
    state: 'not-set-up',
    needs: ['bubblewrap', 'socat', 'ripgrep'],
    command: null,
    prompt: false,
  });
});

test('on Linux the setup installs through pkexec, and packages installed in a terminal are found next time', async () => {
  let programs = ['bwrap', 'apt-get', 'pkexec'];
  const find = program => (programs.includes(program) ? `/usr/bin/${program}` : null),
    read = () =>
      readBuiltInSandboxStatus({ cli: builtInSandboxRunner }, undefined, {
        platform: 'linux',
        find,
        environment: { XDG_CURRENT_DESKTOP: 'KDE' },
      }),
    started = [];
  const run = (executable, args) => {
    started.push([executable, ...args]);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    setImmediate(() => {
      child.stderr.emit('data', 'Request dismissed\n');
      child.emit('close', 126);
    });
    return child;
  };
  const sandbox = builtInSandbox({ cli: builtInSandboxRunner }, { read, find, run });
  const finished = await new Promise(resolve => assert.equal(sandbox.setup(resolve), true));
  assert.deepEqual(started, [['pkexec', '/usr/bin/apt-get', 'install', '-y', 'socat', 'ripgrep']]);
  assert.equal(finished.state, 'not-set-up');
  assert.deepEqual(sandbox.status().setup, { state: 'failed', exitCode: 126, output: 'Request dismissed' });
  // Installed from a terminal instead: the next read finds them, and the failed setup is forgotten.
  programs = [...programs, 'socat', 'rg'];
  assert.deepEqual(sandbox.status(), { state: 'ready' });
  assert.equal(sandbox.setup(), false, 'Ready.');
  // Without a desktop prompt there is nothing to start; the director runs the command.
  programs = ['bwrap'];
  const headless = builtInSandbox(
    {},
    { read: () => readBuiltInSandboxStatus({ cli: builtInSandboxRunner }, undefined, { platform: 'linux', find }) },
  );
  assert.equal(headless.status().prompt, false);
  assert.equal(headless.setup(), false);
});

test('a run writes only the copy it tests, reads the packages above it, and reaches only this computer', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-built-in-'))),
    root = path.join(directory, 'data', 'wt', 'v-1');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(directory, 'data', 'node_modules'));
  const run = {
    root,
    nodeDirectory: path.join(directory, 'node'),
    launcherDirectory: path.join(directory, 'adapters'),
    runDirectory: path.join(directory, 'run'),
    helper: 'C:\\ProgramData\\Studio desk\\sandbox\\srt-win.exe',
    seccomp: path.join(directory, 'sandbox-runtime', 'vendor', 'seccomp'),
    temporary: path.join(directory, 'run', 'tmp'),
  };
  const settings = builtInSandboxSettings({ ...run, platform: 'win32' });
  assert.deepEqual(settings.network, { allowedDomains: [], deniedDomains: [], allowLocalBinding: true });
  assert.deepEqual(settings.filesystem.allowWrite, [root]);
  assert.deepEqual(settings.filesystem.allowRead.slice(0, 3), [
    path.join(directory, 'node'),
    path.join(directory, 'adapters'),
    path.join(directory, 'run'),
  ]);
  assert.ok(settings.filesystem.allowRead.includes(path.join(directory, 'data', 'node_modules')));
  assert.equal(settings.filesystem.allowRead.includes(path.join(root, 'node_modules')), false);
  assert.deepEqual(settings.windows, { srtWin: { path: run.helper } });
  // macOS and Linux run as the director's own account: the home folder is denied, and what a run uses is let
  // back in, the copy and the runtime's seccomp helper among it; the run's own temporary folder is writable too.
  const home = path.join(directory, 'home'),
    posix = builtInSandboxSettings({ ...run, platform: 'linux', home });
  assert.deepEqual(posix.network, settings.network);
  assert.deepEqual(posix.filesystem.denyRead, [home]);
  // The data folder above the copy (C-40) and the director's key in it (C-01) are denied there by name, so a data
  // folder kept outside the home folder still hides them, the copy and its packages let back in below; Windows'
  // account reads nothing in the profile it is not given.
  const data = path.join(directory, 'data'),
    key = path.join(data, 'director-key');
  fs.writeFileSync(key, 'a'.repeat(64));
  assert.deepEqual(builtInSandboxSettings({ ...run, platform: 'linux', home }).filesystem.denyRead, [home, data, key]);
  const launch = path.join(directory, 'data', 'launch-url');
  fs.writeFileSync(launch, 'http://127.0.0.1:4317/launch/' + 'c'.repeat(48));
  assert.deepEqual(builtInSandboxSettings({ ...run, platform: 'linux', home }).filesystem.denyRead, [
    home,
    data,
    key,
    launch,
  ]);
  fs.rmSync(launch);
  assert.deepEqual(builtInSandboxSettings({ ...run, platform: 'win32' }).filesystem.denyRead, []);
  fs.rmSync(key);
  assert.deepEqual(posix.filesystem.allowRead, [root, ...settings.filesystem.allowRead, run.seccomp]);
  assert.deepEqual(posix.filesystem.allowWrite, [root, run.temporary]);
  assert.equal(posix.windows, undefined);
  // The repositories tests make write their .git/config there; the runtime refuses every .git/hooks regardless.
  assert.equal(posix.filesystem.allowGitConfig, true);
  assert.equal(settings.filesystem.allowGitConfig, undefined, 'Windows is unchanged.');
  // A Node.js install of its own (nvm's, under the home folder) keeps npm in <install>/lib/node_modules/npm beside
  // its bin: that one folder is let back in, once it is there, so npm and npx run.
  const npm = path.join(directory, 'lib', 'node_modules', 'npm');
  fs.mkdirSync(npm, { recursive: true });
  assert.equal(builtInSandboxSettings({ ...run, platform: 'linux', home }).filesystem.allowRead.at(-1), npm);
  assert.equal(builtInSandboxSettings({ ...run, platform: 'win32' }).filesystem.allowRead.includes(npm), false);
  // The command line quotes each path for the shell the runtime starts; the test command is not on it.
  assert.equal(
    builtInSandboxCommandLine('C:\\Program Files\\node\\node.exe', 'C:\\a b\\launch.mjs', 'C:\\t\\run.json', 'win32'),
    '"C:\\Program Files\\node\\node.exe" "C:\\a b\\launch.mjs" "C:\\t\\run.json"',
  );
  assert.equal(
    builtInSandboxCommandLine('/usr/bin/node', "/home/a b/it's/launch.mjs", '/tmp/$run.json', 'linux'),
    `'/usr/bin/node' '/home/a b/it'\\''s/launch.mjs' '/tmp/$run.json'`,
  );
  // Only the controller's variables for the tests go in; nothing else from its environment, which may hold sign-ins.
  const environment = { STUDIO_MODEL_FREE_LEAF_FIXTURES: '1', GH_TOKEN: 'secret', PATH: '/bin', HOME: '/home/a' };
  assert.deepEqual(builtInSandboxEnvironment(environment), { STUDIO_MODEL_FREE_LEAF_FIXTURES: '1' });
  // On macOS and Linux the runtime passes its environment on, so it starts with only the basics.
  assert.deepEqual(builtInSandboxRuntimeEnvironment(environment), { PATH: '/bin', HOME: '/home/a' });
});

test('the director sets up the built-in sandbox from Settings, one setup at a time', async t => {
  const sandbox = fakeSandbox('not-set-up'),
    c = await setup(t, 'pass', undefined, { builtInSandbox: sandbox }),
    projectId = c.app.store.projects()[0].id,
    read = async route => (await fetch(c.origin + route, { headers: { 'X-Studio-Token': c.token } })).json();
  assert.deepEqual((await read(`/api/projects/${projectId}/shell`)).builtInSandbox, { state: 'not-set-up' });
  assert.deepEqual(
    (await read('/api/templates')).builtInSandbox,
    { state: 'not-set-up' },
    'The first run reads it too.',
  );
  assert.equal((await c.request('/api/built-in-sandbox', { setting: true })).status, 400);
  assert.equal((await c.request('/api/built-in-sandbox', {})).status, 200);
  assert.equal(sandbox.setups, 1);
  sandbox.finish('ready');
  assert.match(
    c.app.store
      .events()
      .filter(event => event.kind === 'control')
      .at(-1).message,
    /is set up/,
  );
  assert.equal((await c.request('/api/built-in-sandbox', {})).status, 409, 'Set up already.');
  // Ready, it is where the next tests run unless the director chose; the director may choose it.
  assert.equal((await read(`/api/projects/${projectId}/shell`)).testSandbox, 'built-in');
  assert.equal((await c.request('/api/control', { testSandbox: 'none' })).status, 200);
  assert.equal((await c.request('/api/control', { testSandbox: 'built-in' })).status, 200);
  assert.equal(c.app.store.organization().testSandbox, 'built-in');
  assert.match(
    c.app.store
      .events()
      .filter(event => event.kind === 'control')
      .at(-1).message,
    /built-in sandbox/,
  );
});
