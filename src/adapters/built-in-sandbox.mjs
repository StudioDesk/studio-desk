// The built-in sandbox for candidate tests and an idea's checks (1.0.1): Anthropic's open-source sandbox
// runtime, pinned in the lockfile and installed by `npm ci` with the dashboard's tools. The controller
// never imports it: it runs the runtime's own programs, so the controller keeps no dependencies and
// starts without them. On Windows the runtime needs a one-time setup that asks for an administrator
// (a local `srt-sandbox` account and a machine-wide network filter); the director starts it from
// Settings → Candidate tests. macOS needs nothing: the runtime uses its built-in sandbox-exec. Linux needs
// three programs from the system's packages (bubblewrap, socat, ripgrep), which no npm package can supply:
// Ubuntu lets only the system's bubblewrap make sandboxes. The same setup installs them through the
// system's own password prompt, or the director copies the command.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { directorKeyName, directorSecretNames } from '../director-access.mjs';
import { processEnded } from './process.mjs';

export const builtInSandboxVersion = '0.0.81';
const studioRoot = fileURLToPath(new URL('../../', import.meta.url));
// The program that runs one test command in the sandbox, as a process of its own (built-in-sandbox-run.mjs).
export const builtInSandboxRunner = fileURLToPath(new URL('./built-in-sandbox-run.mjs', import.meta.url));

export function builtInSandboxFiles(root = studioRoot) {
  const runtime = path.join(root, 'node_modules', '@anthropic-ai', 'sandbox-runtime');
  return {
    cli: path.join(runtime, 'dist', 'cli.js'),
    // On Linux the sandboxed command starts through the runtime's seccomp helper, so it must be readable inside.
    seccomp: path.join(runtime, 'vendor', 'seccomp'),
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

// A program on the PATH, as the shell would find it.
export function onPath(program, environment = process.env) {
  for (const folder of (environment.PATH || '').split(path.delimiter).filter(Boolean))
    try {
      fs.accessSync(path.join(folder, program), fs.constants.X_OK);
      return path.join(folder, program);
    } catch {
      // Not in this folder.
    }
  return null;
}

// What the runtime needs on Linux, as program and package, and how each system's package manager installs
// them. Every one of them names the three packages alike.
export const linuxSandboxPrograms = [
  ['bwrap', 'bubblewrap'],
  ['socat', 'socat'],
  ['rg', 'ripgrep'],
];
const packageManagers = [
  ['apt-get', 'install', '-y'],
  ['dnf', 'install', '-y'],
  ['pacman', '-S', '--needed', '--noconfirm'],
  ['zypper', '--non-interactive', 'install'],
];
// The install of the packages this computer lacks, by the first package manager found, or null.
export function linuxSandboxInstall(needs, find = onPath) {
  const manager = packageManagers.find(([program]) => find(program));
  return manager ? [...manager, ...needs] : null;
}

// Where this computer stands: `missing` (the packages are not installed: run npm ci), `unsupported`
// (a system the runtime has no sandbox for), `not-set-up`, `outdated` (set up by another release of the
// runtime, so the setup has to run again) or `ready`. On Linux, not set up also names the packages it needs,
// the command that installs them, to copy, and whether the setup can ask for the password itself: with
// pkexec in a desktop session, which shows the system's prompt (WSL and a server without one have none).
export function readBuiltInSandboxStatus(
  files = builtInSandboxFiles(),
  run = spawnSync,
  { platform = process.platform, find = onPath, environment = process.env } = {},
) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) return { state: 'unsupported' };
  if (!fs.existsSync(files.cli)) return { state: 'missing' };
  if (platform === 'darwin') return find('sandbox-exec') ? { state: 'ready' } : { state: 'unsupported' };
  if (platform === 'linux') {
    const needs = linuxSandboxPrograms.filter(([program]) => !find(program)).map(([, name]) => name);
    if (!needs.length) return { state: 'ready' };
    const install = linuxSandboxInstall(needs, find);
    return {
      state: 'not-set-up',
      needs,
      command: install && `sudo ${install.join(' ')}`,
      prompt: Boolean(install && find('pkexec') && (environment.XDG_CURRENT_DESKTOP || environment.DESKTOP_SESSION)),
    };
  }
  if (!fs.existsSync(files.srtWin)) return { state: 'missing' };
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

// The one-time setup's command. The runtime asks Windows for an administrator itself, so the director sees
// Windows' own prompt; on Linux pkexec shows the system's password prompt and runs the install.
export function builtInSandboxSetupCommand(status, files = builtInSandboxFiles(), find = onPath) {
  if (!status.needs) return { executable: process.execPath, args: [files.cli, ...builtInSandboxSetupArgs] };
  const [manager, ...install] = linuxSandboxInstall(status.needs, find);
  return { executable: 'pkexec', args: [find(manager), ...install] };
}

// Runs the one-time setup; `done` gets the exit code and what the setup printed.
export function startBuiltInSandboxSetup(command, done, run = spawn) {
  const child = run(command.executable, command.args, {
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
// sandbox set up on the computer running them never changes what they choose. Linux packages the director
// installs from a terminal are found when the state is next read; looking for three programs is cheap.
export function builtInSandbox(
  files = builtInSandboxFiles(),
  { read = () => readBuiltInSandboxStatus(files), find = onPath, run = spawn } = {},
) {
  let status = read(),
    setup = null;
  return {
    status() {
      if (status.needs && setup?.state !== 'running') {
        status = read();
        if (status.state === 'ready') setup = null;
      }
      return setup ? { ...status, setup } : status;
    },
    setup(done = () => {}) {
      if (setup?.state === 'running' || !['not-set-up', 'outdated'].includes(status.state)) return false;
      if (status.needs && !status.prompt) return false;
      setup = { state: 'running', startedAt: new Date().toISOString() };
      startBuiltInSandboxSetup(
        builtInSandboxSetupCommand(status, files, find),
        (exitCode, output) => {
          status = read();
          setup = status.state === 'ready' ? null : { state: 'failed', exitCode, output };
          done(status);
        },
        run,
      );
      return true;
    },
  };
}
export const noBuiltInSandbox = { status: () => ({ state: 'unsupported' }), setup: () => false };
export const builtInSandboxReady = runtime => runtime.builtInSandbox?.status().state === 'ready';

// The packages installed for a copy: any `node_modules` in a folder above it, where Node's lookup finds them,
// and any `package.json` there, which Node reads to know how the files below it load (the data folder's marks
// where the pipeline's installed packages begin).
export function builtInSandboxPackages(root) {
  const packages = [];
  for (let folder = path.dirname(root); folder !== path.dirname(folder); folder = path.dirname(folder))
    for (const name of ['node_modules', 'package.json'])
      if (fs.existsSync(path.join(folder, name))) packages.push(path.join(folder, name));
  return packages;
}

// The files of the data folder a copy sits in that let a program act as the director (C-01, src/director-access.mjs):
// the key, the launch link, whose code sets the session cookie, and the tools' keys. They are found the way the
// packages are, in a folder above the copy. On macOS and Linux they are denied by name, so a data folder kept outside
// the home folder still hides them. On Windows the sandbox account cannot read a data folder inside the director's
// profile; one outside the profile gets them denied before each run (below).
export function builtInSandboxSecrets(root) {
  const secrets = [];
  for (let folder = path.dirname(root); folder !== path.dirname(folder); folder = path.dirname(folder))
    for (const name of directorSecretNames)
      if (fs.existsSync(path.join(folder, name))) secrets.push(path.join(folder, name));
  return secrets;
}
// The data folder a copy sits in: the nearest folder above it that holds the director's key; null for a copy outside
// any data folder.
export function builtInSandboxDataFolder(root) {
  for (let folder = path.dirname(root); folder !== path.dirname(folder); folder = path.dirname(folder))
    if (fs.existsSync(path.join(folder, directorKeyName))) return folder;
  return null;
}

// What one test run may touch. It writes only the copy it runs on; it reads Node, the packages installed for
// the copy, the launcher and the run's own instructions; it reaches no network beyond this computer. Git for
// Windows and Windows' own folders are readable to every account already. On macOS and Linux the tests run as
// the director's own account, which can read the whole home folder, so the home folder is denied and only
// what a run uses is let back in, as Windows' sandbox account sees it, with the runtime's seccomp helper;
// system folders stay readable. Those systems also give the run a temporary folder of its own to write, where
// Windows' account has its own. The repositories tests make may write their .git/config (`allowGitConfig`):
// they sit in the disposable copy or the run's temporary folder, and the project's own repository is outside
// what a run may write. Every .git/hooks stays refused. npm and npx run from the npm package of the Node.js
// install (<install>/lib/node_modules/npm beside its bin), which a home-folder install such as nvm's keeps out
// of reach otherwise; only that folder is let back in, and only when it is there.
export function builtInSandboxSettings({
  root,
  nodeDirectory,
  launcherDirectory,
  runDirectory,
  helper,
  seccomp,
  temporary,
  platform = process.platform,
  home = os.homedir(),
}) {
  const network = { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
    reads = [nodeDirectory, launcherDirectory, runDirectory, ...builtInSandboxPackages(root)];
  if (platform !== 'win32') {
    const npm = path.join(path.dirname(nodeDirectory), 'lib', 'node_modules', 'npm');
    return {
      network,
      filesystem: {
        // The data folder too, for one kept outside the home folder: its database, its other projects' copies and
        // records. The copy and its packages are let back in below, as on Windows (C-40).
        denyRead: [
          home,
          ...(builtInSandboxDataFolder(root) ? [builtInSandboxDataFolder(root)] : []),
          ...builtInSandboxSecrets(root),
        ],
        allowRead: [root, ...reads, seccomp, ...(fs.existsSync(npm) ? [npm] : [])],
        allowWrite: [root, temporary],
        denyWrite: [],
        allowGitConfig: true,
      },
    };
  }
  return {
    network,
    filesystem: { denyRead: [], allowRead: reads, allowWrite: [root], denyWrite: [] },
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

// On Windows the sandbox account reads what every account may read, and a data folder outside the director's profile
// (C:\StudioDesk, say) lets every signed-in account read it: a probe on November 1, 2026 read the director's key and
// the database there (C-40), and on November 2 the launch link's file beside the key. Before each run, the director's
// key, launch link and the tools' keys above the copy are denied to the runtime's sandbox group by an entry of their
// own (a folder's reaching everything in it), so they stay the director's wherever the data folder is. A file that
// cannot be denied stops the run rather than leaving it readable.
export function denyBuiltInSandboxSecrets(secrets, run = spawnSync) {
  for (const secret of secrets) {
    const folder = fs.statSync(secret, { throwIfNoEntry: false })?.isDirectory();
    const result = run('icacls', [secret, '/deny', `${builtInSandboxGroup}:${folder ? '(OI)(CI)(R)' : '(R)'}`], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    if (result.status !== 0)
      throw new Error(
        `The sandbox could not be kept from the director's sign-in file (${secret}): ${(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 500)}`,
      );
  }
  return secrets;
}
// The rest of the data folder (C-40's second part, the director's "deny and grant back", November 2): its database,
// its other projects' copies and records. The runtime's sandbox group is denied reading what any of it holds, the
// folder's own listing included, by one entry everything in it inherits. Looking at a folder is still allowed, since
// Node looks at each folder on the way to the copy. What a run uses is let back in by the runtime's own grants, which
// it gives the copy and its packages explicitly and which therefore come before the inherited deny. Probed on a data
// folder outside the profile: the database and the listing refused; the copy written, its packages read and loaded.
//
// Setting the entry makes Windows write it to everything already in the folder, which on a live data folder (job copies,
// worktrees, packages) takes minutes: run before every test, it failed every run on November 3 at its 30-second limit.
// So a data folder inside the director's profile gets none: the profile's own permissions keep the sandbox account out,
// as nothing on the way grants it, or its Users group, a read. One outside the profile gets the entry once, under a
// lock, with as long as the writing takes; a run that finds the lock waits for it. A file beside the lock records that
// the writing finished, as one cut short leaves the folder's own entry without everything below it. With that file
// there, a run reads only the folder's own list, which is quick.
const dataDenyEntry = new RegExp(`${builtInSandboxGroup}:\\(OI\\)\\(CI\\)\\(DENY\\)\\(RD\\)`, 'i');
export const dataDenyTimeoutMs = 30 * 60 * 1000;
export const dataDenyLock = '.sandbox-data-deny.lock',
  dataDenyDone = '.sandbox-data-denied';
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lockHolderAlive = file => {
  try {
    process.kill(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
export const insideFolder = (parent, child) => {
  const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
};
// Whether the folder's own access list holds the data deny, read without touching anything below it.
export function builtInSandboxDataDenied(folder, run = spawnSync) {
  const result = run('icacls', [folder], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return result.status === 0 && dataDenyEntry.test(String(result.stdout || ''));
}
export function denyBuiltInSandboxData(
  folder,
  {
    run = spawnSync,
    profile = process.env.USERPROFILE || os.homedir(),
    timeoutMs = dataDenyTimeoutMs,
    waitMs = 1000,
  } = {},
) {
  if (!folder || insideFolder(profile, folder)) return null;
  const lock = path.join(folder, dataDenyLock),
    done = path.join(folder, dataDenyDone),
    denied = () => fs.existsSync(done) && builtInSandboxDataDenied(folder, run);
  if (denied()) return folder;
  for (const until = Date.now() + timeoutMs; ; ) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // Another run is writing the entry: it is there once that run is done, or the lock was left by a run that ended.
    if (!lockHolderAlive(lock)) fs.rmSync(lock, { force: true });
    else if (denied()) return folder;
    else if (Date.now() > until)
      throw new Error(
        `The sandbox could not be kept from the data folder (${folder}): another run held its lock too long.`,
      );
    else sleepSync(waitMs);
  }
  try {
    if (denied()) return folder;
    const result = run('icacls', [folder, '/deny', `${builtInSandboxGroup}:(OI)(CI)(RD)`], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
    });
    if (result.status !== 0)
      throw new Error(
        `The sandbox could not be kept from the data folder (${folder}): ${(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 500)}`,
      );
    fs.writeFileSync(done, `${new Date().toISOString()}\n`);
    return folder;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// How many built-in sandbox sessions run at once on this computer (C-43, November 2). On Windows the runtime's network
// proxy binds inside the loopback range its install permitted, 60080-60089 by default, at two ports a session, so a
// sixth session failed at setup ("EADDRINUSE 127.0.0.1:60089") whenever five were running: the pipeline's agents' own
// test runs, its checks and integrations, and npm run verify all start one. Four leave a session spare.
export const builtInSandboxSessionsAtOnce = 4;
// Where the computer's session slots are kept: beside the helper's shared copy, which every copy of Studio desk on this
// computer uses, so the controller and npm run verify share them.
export const builtInSandboxSessionFolder = files => path.join(path.dirname(files.sharedSrtWin), 'sessions');

// How long a run waits for a session before it stops with a plain reason: ten minutes, well under the shortest time limit
// a candidate's tests run with, so a run that cannot get one says why rather than being stopped at its limit.
export const builtInSandboxSessionWaitMs = 10 * 60 * 1000;
const waitedFor = ms => {
  const [count, unit] = ms >= 60000 ? [Math.round(ms / 60000), 'minute'] : [Number((ms / 1000).toFixed(1)), 'second'];
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
};

// Takes one of the computer's session slots, waiting in turn while all are taken, and answers the function that gives
// it back. A slot is a file made only if absent; a slot whose holder has ended (stopped hard, say) is free again. A
// slot records its holder's ID and when it was taken, after the holder started, so a process that now has the ID but
// started later is not the holder (Windows hands freed IDs on quickly), through the check every caller shares; a slot
// without a readable time keeps the ID-only answer. Reading a start time starts PowerShell on Windows, so a holder found
// genuine is asked again only by its ID (`alive` without a time) on later passes for as long as its slot reads the same.
// Two waiters freeing the same ended slot at the same moment could share it, which the spare session above absorbs.
// With no slot free after `waitBoundMs`, it stops with a plain reason and changes no slot.
export async function takeBuiltInSandboxSession(
  folder,
  {
    slots = builtInSandboxSessionsAtOnce,
    pid = process.pid,
    readStartTime,
    alive = (holder, since) => !processEnded(holder, since, { readStartTime }),
    waitMs = 500,
    waitBoundMs = builtInSandboxSessionWaitMs,
    onWait,
  } = {},
) {
  fs.mkdirSync(folder, { recursive: true });
  const started = Date.now(),
    genuine = new Set();
  for (let waited = false; ; waited = true) {
    for (let slot = 0; slot < slots; slot++) {
      const file = path.join(folder, `slot-${slot}.lock`);
      try {
        fs.writeFileSync(file, JSON.stringify({ pid, since: new Date().toISOString() }), { flag: 'wx' });
        return () => {
          try {
            if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.rmSync(file, { force: true });
          } catch {}
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      let text = '',
        holder = null;
      try {
        text = fs.readFileSync(file, 'utf8');
        holder = JSON.parse(text);
      } catch {
        // Being written, or just given back: the next pass looks again.
      }
      if (!holder || !Number.isInteger(holder.pid)) continue;
      const known = genuine.has(text);
      if (alive(holder.pid, known ? null : holder.since)) genuine.add(text);
      else {
        genuine.delete(text);
        fs.rmSync(file, { force: true });
        slot--;
      }
    }
    if (!waited) onWait?.(slots);
    const elapsed = Date.now() - started;
    if (elapsed >= waitBoundMs)
      throw new Error(
        `All ${slots} of this computer's built-in sandbox sessions stayed in use by runs still going, so this run stopped after waiting ${waitedFor(elapsed)} for one.`,
      );
    await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, waitBoundMs - elapsed)));
  }
}

// The command line the runtime runs inside the sandbox, through cmd.exe on Windows and sh elsewhere. The test
// command itself travels in the run's instructions file, so none of its arguments is quoted for a shell.
export const builtInSandboxCommandLine = (node, launcher, instructions, platform = process.platform) =>
  [node, launcher, instructions]
    .map(part => (platform === 'win32' ? `"${part}"` : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(' ');

// The runtime hands the sandboxed command only PATH and its own proxy settings, so the controller's
// variables for the tests (the copied harness's marker) travel in the instructions and the launcher sets
// them. Nothing else from the controller's environment, which may hold sign-ins, goes in.
export const builtInSandboxEnvironment = environment =>
  Object.fromEntries(Object.entries(environment).filter(([name]) => /^STUDIO_/i.test(name)));
// On macOS and Linux the runtime passes its own environment on to the command, so it is started with only
// what finding programs, the home folder and the language need.
export const builtInSandboxRuntimeEnvironment = environment =>
  Object.fromEntries(
    Object.entries(environment).filter(([name]) =>
      ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'].includes(name),
    ),
  );
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
