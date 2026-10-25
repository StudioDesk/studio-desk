// The built-in sandbox for candidate tests and an idea's checks (1.0.1): Anthropic's open-source sandbox
// runtime, pinned in the lockfile and installed by `npm ci` with the dashboard's tools. The controller
// never imports it: it runs the runtime's own programs, so the controller keeps no dependencies and
// starts without them. On Windows the runtime needs a one-time setup that asks for an administrator
// (a local `srt-sandbox` account and a machine-wide network filter); the director starts it from
// Settings → Candidate tests.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const builtInSandboxVersion = '0.0.81';
const studioRoot = fileURLToPath(new URL('../../', import.meta.url));
// The program that runs one test command in the sandbox, as a process of its own (built-in-sandbox-run.mjs).
export const builtInSandboxRunner = fileURLToPath(new URL('./built-in-sandbox-run.mjs', import.meta.url));

export function builtInSandboxFiles(root = studioRoot) {
  const runtime = path.join(root, 'node_modules', '@anthropic-ai', 'sandbox-runtime');
  return {
    cli: path.join(runtime, 'dist', 'cli.js'),
    srtWin: path.join(runtime, 'vendor', 'srt-win', process.arch === 'arm64' ? 'arm64' : 'x64', 'srt-win.exe'),
  };
}

// Setup allows tests to connect within this computer, since test suites start local servers, and makes
// nothing in the director's user profile readable: tests read only the copy they run on, the installed
// packages, Node and Git (the director's choice, October 25).
export const builtInSandboxSetupArgs = ['windows-install', '--allow-loopback', '--skip-profile-grant'];

// Where this computer stands: `missing` (the packages are not installed: run npm ci), `unsupported`
// (not Windows; macOS and Linux come with the platforms), `not-set-up`, `outdated` (set up by another
// release of the runtime, so the setup has to run again) or `ready`.
export function readBuiltInSandboxStatus(files = builtInSandboxFiles(), run = spawnSync) {
  if (process.platform !== 'win32') return { state: 'unsupported' };
  if (!fs.existsSync(files.cli) || !fs.existsSync(files.srtWin)) return { state: 'missing' };
  const probe = run(files.srtWin, ['status'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  let status;
  try {
    status = JSON.parse(probe.stdout);
  } catch {
    return { state: 'not-set-up', detail: (probe.stderr || probe.error?.message || 'No status').trim().slice(0, 300) };
  }
  return builtInSandboxState(status);
}

// The sandbox account with its stored credential, set up by this release of the runtime.
export function builtInSandboxState(status) {
  const user = status?.user ?? {};
  if (!user.user?.exists || !user.cred_present) return { state: 'not-set-up' };
  if (user.marker_version !== user.setup_version) return { state: 'outdated' };
  return { state: 'ready' };
}

// Runs the one-time setup. The runtime asks Windows for an administrator itself, so the director sees
// Windows' own prompt; `done` gets the exit code and what the setup printed.
export function startBuiltInSandboxSetup(files = builtInSandboxFiles(), done, run = spawn) {
  const child = run(process.execPath, [files.cli, ...builtInSandboxSetupArgs], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const channel of [child.stdout, child.stderr])
    channel?.on('data', chunk => (output = (output + chunk).slice(-4000)));
  child.on('error', error => done(1, error.message));
  child.on('close', code => done(code ?? 1, output.trim()));
  return child;
}

// The controller's view of the built-in sandbox on this computer: its state, refreshed after a setup, and
// the setup itself, one at a time. The controller's own start passes this one; tests pass their own, so a
// sandbox set up on the computer running them never changes what they choose.
export function builtInSandbox(files = builtInSandboxFiles()) {
  let status = readBuiltInSandboxStatus(files),
    setup = null;
  return {
    status: () => (setup ? { ...status, setup } : status),
    setup(done = () => {}) {
      if (setup?.state === 'running' || !['not-set-up', 'outdated'].includes(status.state)) return false;
      setup = { state: 'running', startedAt: new Date().toISOString() };
      startBuiltInSandboxSetup(files, (exitCode, output) => {
        status = readBuiltInSandboxStatus(files);
        setup = status.state === 'ready' ? null : { state: 'failed', exitCode, output };
        done(status);
      });
      return true;
    },
  };
}
export const noBuiltInSandbox = { status: () => ({ state: 'unsupported' }), setup: () => false };
export const builtInSandboxReady = runtime => runtime.builtInSandbox?.status().state === 'ready';

// What one test run may touch. It writes only the copy it runs on; it reads Node, the packages installed
// for the copy (any `node_modules` in a folder above it, where Node's lookup finds them), the launcher and
// the run's own instructions; it reaches no network beyond this computer. Git for Windows and Windows'
// own folders are readable to every account already.
export function builtInSandboxSettings({ root, nodeDirectory, launcherDirectory, runDirectory }) {
  const packages = [];
  for (let folder = path.dirname(root); folder !== path.dirname(folder); folder = path.dirname(folder))
    if (fs.existsSync(path.join(folder, 'node_modules'))) packages.push(path.join(folder, 'node_modules'));
  return {
    network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
    filesystem: {
      denyRead: [],
      allowRead: [nodeDirectory, launcherDirectory, runDirectory, ...packages],
      allowWrite: [root],
      denyWrite: [],
    },
  };
}

// The command line the runtime runs inside the sandbox (through cmd.exe on Windows). The test command
// itself travels in the run's instructions file, so none of its arguments is quoted for a shell.
export const builtInSandboxCommandLine = (node, launcher, instructions) =>
  [node, launcher, instructions].map(part => `"${part}"`).join(' ');

// The runtime hands the sandboxed command only PATH and its own proxy settings, so the controller's
// variables for the tests (the copied harness's marker) travel in the instructions and the launcher sets
// them. Nothing else from the controller's environment, which may hold sign-ins, goes in.
export const builtInSandboxEnvironment = environment =>
  Object.fromEntries(Object.entries(environment).filter(([name]) => /^STUDIO_/i.test(name)));

// The test command run through the built-in sandbox: the runner gets the folder the tests may write
// (the copy they run on) and the command itself.
export function builtInSandboxCommand(plan) {
  return {
    executable: process.execPath,
    args: [builtInSandboxRunner, '--root', plan.root, '--', plan.command.executable, ...plan.command.args],
  };
}
