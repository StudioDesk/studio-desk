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
import { setup } from './source-story-setup.mjs';
import {
  builtInSandbox,
  builtInSandboxCommand,
  builtInSandboxCommandLine,
  builtInSandboxEnvironment,
  builtInSandboxRunner,
  builtInSandboxRuntimeEnvironment,
  builtInSandboxSettings,
  builtInSandboxState,
  builtInSandboxVersion,
  readBuiltInSandboxStatus,
} from '../src/adapters/built-in-sandbox.mjs';

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
