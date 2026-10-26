// The built-in sandbox for candidate tests and an idea's checks (1.0.1): Anthropic's open-source sandbox
// runtime, pinned in the lockfile and installed by `npm ci` with the dashboard's tools. The controller
// never imports it: it runs the runtime's own programs, so the controller keeps no dependencies and
// starts without them. On Windows the runtime needs a one-time setup that asks for an administrator
// (a local `srt-sandbox` account and a machine-wide network filter); the director starts it from
// Settings → Candidate tests.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
    // The runtime starts its helper again as the sandbox account, which cannot read a copy of Studio desk under
    // the director's profile (where none of the profile is readable to it). So the helper runs from a copy in
    // ProgramData, which every account may read and the runtime's setup keeps the sandbox account from writing.
    sharedSrtWin: path.join(
      process.env.ProgramData || 'C:\\ProgramData',
      'Studio desk',
      'sandbox',
      `srt-win-${builtInSandboxVersion}-${process.arch}.exe`,
    ),
  };
}

// Puts the helper's shared copy in place when it is missing or differs from the installed one.
export function shareBuiltInSandboxHelper(files = builtInSandboxFiles()) {
  const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (fs.existsSync(files.sharedSrtWin) && digest(files.sharedSrtWin) === digest(files.srtWin)) return;
  fs.mkdirSync(path.dirname(files.sharedSrtWin), { recursive: true });
  fs.copyFileSync(files.srtWin, files.sharedSrtWin);
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

// The packages installed for a copy: any `node_modules` in a folder above it, where Node's lookup finds them.
export function builtInSandboxPackages(root) {
  const packages = [];
  for (let folder = path.dirname(root); folder !== path.dirname(folder); folder = path.dirname(folder))
    if (fs.existsSync(path.join(folder, 'node_modules'))) packages.push(path.join(folder, 'node_modules'));
  return packages;
}

// What one test run may touch. It writes only the copy it runs on; it reads Node, the packages installed for
// the copy, the launcher and the run's own instructions; it reaches no network beyond this computer. Git for
// Windows and Windows' own folders are readable to every account already.
export function builtInSandboxSettings({ root, nodeDirectory, launcherDirectory, runDirectory, helper }) {
  return {
    network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
    filesystem: {
      denyRead: [],
      allowRead: [nodeDirectory, launcherDirectory, runDirectory, ...builtInSandboxPackages(root)],
      allowWrite: [root],
      denyWrite: [],
    },
    windows: { srtWin: { path: helper } },
  };
}

// Node looks at every folder above a file it runs, and the sandbox account may not even look at the folders in
// the director's profile. Each folder inside the profile above what a run uses gets a see-only entry for the
// runtime's sandbox group: "read attributes", so the folder can be found but not opened or listed (the
// director's choice, October 25). The profile folder itself needs none, since its parent lets every account
// look in. Each run checks the folders, since the runtime's own cleanup of a folder it was given takes the
// group's entries there with it; every folder ever changed is recorded beside the helper's shared copy, so
// they can all be found again.
export const builtInSandboxGroup = 'sandbox-runtime-users';
export function builtInSandboxPassThrough(paths, home = os.homedir()) {
  const folders = new Set(),
    inside = folder => path.relative(home, folder) && !path.relative(home, folder).startsWith('..');
  for (const target of paths)
    for (let folder = path.dirname(path.resolve(target)); inside(folder); folder = path.dirname(folder))
      folders.add(folder);
  return [...folders];
}
// The entry is written with SetFileSecurity, which changes the one folder: the usual tools re-apply inheritance
// to everything beneath it, which takes minutes under AppData. The folders come in on standard input, and the
// script prints those it changed.
const passThroughScript = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace StudioDesk -Name Acl -MemberDefinition '[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetFileSecurity(string name, int information, byte[] descriptor);'
$sid = [System.Security.Principal.SecurityIdentifier]
$group = (New-Object System.Security.Principal.NTAccount('${builtInSandboxGroup}')).Translate($sid)
foreach ($folder in @($input)) {
  $acl = Get-Acl -LiteralPath $folder
  $present = $acl.GetAccessRules($true, $false, $sid) | Where-Object {
    $_.IdentityReference -eq $group -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band 128)
  }
  if ($present) { continue }
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($group, 'ReadAttributes', 'None', 'None', 'Allow')))
  if (-not [StudioDesk.Acl]::SetFileSecurity($folder, 4, $acl.GetSecurityDescriptorBinaryForm())) {
    throw "$($folder) error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $folder
}`;
export function openBuiltInSandboxPassThrough(paths, files = builtInSandboxFiles(), run = spawnSync) {
  const record = path.join(path.dirname(files.sharedSrtWin), 'pass-through.json');
  const folders = builtInSandboxPassThrough(paths);
  if (!folders.length) return [];
  const result = run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(passThroughScript, 'utf16le').toString('base64')],
    { input: folders.join('\n'), encoding: 'utf8', windowsHide: true, timeout: 60000 },
  );
  if (result.status !== 0)
    throw new Error(
      `The sandbox could not be let through the folders above its work: ${(result.stderr || result.error?.message || '').trim().slice(0, 500)}`,
    );
  const changed = result.stdout.split(/\r?\n/).filter(Boolean);
  if (changed.length) {
    let recorded = [];
    try {
      recorded = JSON.parse(fs.readFileSync(record, 'utf8'));
    } catch {
      // None recorded yet.
    }
    fs.writeFileSync(record, JSON.stringify([...new Set([...recorded, ...changed])], null, 2));
  }
  return changed;
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
// git's global settings for the sandbox account, which has none of its own: a neutral name and email.
export const builtInSandboxGitConfiguration =
  '[user]\n\tname = Studio desk tests\n\temail = tests@studio-desk.invalid\n';

// The test command run through the built-in sandbox: the runner gets the folder the tests may write
// (the copy they run on) and the command itself.
export function builtInSandboxCommand(plan) {
  return {
    executable: process.execPath,
    args: [builtInSandboxRunner, '--root', plan.root, '--', plan.command.executable, ...plan.command.args],
  };
}
