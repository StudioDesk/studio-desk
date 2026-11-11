// Runs one test command in the built-in sandbox (1.0.1), as a process of its own so the controller never
// loads the sandbox runtime. It writes the run's settings and instructions to a folder of their own, has
// the runtime run the launcher inside the sandbox, passes the output and exit code through, and then takes
// back the write access the runtime keeps on the copy between sessions. The helper's shared copy, the folders'
// see-only entries and the kept write access are Windows' own; macOS and Linux need none of them.
// Usage: node built-in-sandbox-run.mjs --root <the folder the tests may write> [--data <the controller's data folder>]
//   [--deadline-ms <positive integer>] -- <executable> [args...]
// The controller names its own data folder (--data), which the run is kept from wherever the copy is; a command recorded
// before it did so still runs, kept only from a data folder above the copy.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from '../core/entry-point.mjs';
import { realPath } from '../core/real-path.mjs';
import {
  builtInSandboxCommandLine,
  builtInSandboxEnvironment,
  builtInSandboxFiles,
  builtInSandboxGitConfiguration,
  builtInSandboxPackages,
  builtInSandboxRunArguments,
  builtInSandboxRunUsage,
  builtInSandboxRuntimeEnvironment,
  builtInSandboxSessionFolder,
  builtInSandboxSessionWaitBudget,
  builtInSandboxSettings,
  denyBuiltInSandboxDataFolders,
  openBuiltInSandboxPassThrough,
  shareBuiltInSandboxHelper,
  takeBuiltInSandboxSession,
} from './built-in-sandbox.mjs';

// Injectable process and setup boundaries let model-free tests exercise the actual runner and cleanup.
export async function runBuiltInSandbox(
  argv,
  {
    platform = process.platform,
    now = Date.now,
    files = builtInSandboxFiles(),
    prepareWindows = prepareWindowsRun,
    takeSession = takeBuiltInSandboxSession,
    run = spawn,
    runSync = spawnSync,
    log = console.error,
  } = {},
) {
  const windows = platform === 'win32';
  const parsed = builtInSandboxRunArguments(argv);
  if (!parsed) {
    log(builtInSandboxRunUsage);
    return 2;
  }
  const root = path.resolve(parsed.root),
    data = parsed.data && path.resolve(parsed.data),
    { executable, args } = parsed,
    launcher = fileURLToPath(new URL('./built-in-sandbox-launch.mjs', import.meta.url)),
    // Node as the sandbox account sees it: the installed folder, not a link to it (nvm's, for one).
    node = realPath(process.execPath),
    runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sandbox-')),
    settings = path.join(runDirectory, 'settings.json'),
    instructions = path.join(runDirectory, `run-${randomUUID()}.json`),
    temporary = path.join(runDirectory, 'tmp'),
    // On macOS and Linux the tests run as the director's account, whose home folder the sandbox hides, so they get
    // a home of their own, as Windows' sandbox account has. The runtime refuses writes to any repository's
    // .git/hooks, so the repositories tests make take git's hook samples from an empty folder.
    home = path.join(temporary, 'home'),
    gitTemplates = path.join(runDirectory, 'git-templates');
  let releaseSession = () => {};
  try {
    if (windows) prepareWindows(root, node, launcher, runDirectory, files, data);
    else for (const folder of [home, gitTemplates]) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      settings,
      JSON.stringify(
        builtInSandboxSettings({
          root,
          data,
          nodeDirectory: path.dirname(node),
          launcherDirectory: path.dirname(launcher),
          runDirectory,
          helper: files.sharedSrtWin,
          seccomp: files.seccomp,
          temporary,
        }),
      ),
    );
    // The sandbox account is an account of its own, with no git name or email, which tests that commit (or a
    // controller under test that checks for one) need. A neutral one goes where the director's own would be,
    // in git's global settings, so a repository's own settings still come first.
    const gitConfiguration = path.join(runDirectory, 'gitconfig');
    fs.writeFileSync(gitConfiguration, builtInSandboxGitConfiguration);
    fs.writeFileSync(
      instructions,
      JSON.stringify({
        cwd: process.cwd(),
        executable: executable === process.execPath ? node : executable,
        args,
        env: {
          ...builtInSandboxEnvironment(process.env),
          GIT_CONFIG_GLOBAL: gitConfiguration,
          ...(windows
            ? {}
            : {
                TMPDIR: temporary,
                TMP: temporary,
                TEMP: temporary,
                HOME: home,
                GIT_TEMPLATE_DIR: gitTemplates,
              }),
        },
      }),
    );
    // One of the computer's built-in sandbox sessions, which a sixth session at once on Windows could not set up (C-43):
    // this run waits in turn for one, shared with every other copy of Studio desk here, npm run verify included. A run that
    // gets none within the wait's bound ends as any other run does, saying why, with its folder and grant cleaned up.
    const waitBoundMs = builtInSandboxSessionWaitBudget(parsed.deadlineMs, now());
    if (waitBoundMs <= 0)
      throw new Error('The checks time allowance was exhausted before a sandbox session could start.');
    if (windows)
      releaseSession = await takeSession(builtInSandboxSessionFolder(files), {
        waitBoundMs,
        onWait: slots => log(`Waiting for a built-in sandbox session: all ${slots} are in use on this computer.`),
      });
    // Acquisition can itself consume the last of the allowance; never start a runtime past the deadline.
    if (parsed.deadlineMs !== undefined && now() >= parsed.deadlineMs)
      throw new Error('The checks time allowance was exhausted before a sandbox session could start.');
    return await new Promise(resolve => {
      const child = run(
        process.execPath,
        [files.cli, '--settings', settings, '-c', builtInSandboxCommandLine(node, launcher, instructions)],
        {
          cwd: process.cwd(),
          env: windows ? process.env : builtInSandboxRuntimeEnvironment(process.env),
          stdio: 'inherit',
          windowsHide: true,
        },
      );
      const signals = ['SIGINT', 'SIGTERM'].map(signal => {
        const handler = () => child.kill(signal);
        process.on(signal, handler);
        return [signal, handler];
      });
      const done = code => {
        for (const [signal, handler] of signals) process.off(signal, handler);
        resolve(code);
      };
      child.on('error', error => {
        log(`The sandbox runtime did not start: ${error.message}`);
        done(1);
      });
      child.on('close', code => done(code ?? 1));
    });
  } catch (error) {
    log(error.message);
    return 1;
  } finally {
    // The runtime keeps write access between sessions; this copy is tested once, so take it back.
    if (windows) runSync(files.srtWin, ['acl', 'forget', root], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    fs.rmSync(runDirectory, { recursive: true, force: true });
    releaseSession();
  }
}

function prepareWindowsRun(root, node, launcher, runDirectory, files, data) {
  shareBuiltInSandboxHelper(files);
  openBuiltInSandboxPassThrough(
    [root, path.dirname(node), path.dirname(launcher), runDirectory, ...builtInSandboxPackages(root)],
    files,
  );
  denyBuiltInSandboxDataFolders(root, data);
}

if (isEntryPoint(import.meta)) process.exitCode = await runBuiltInSandbox(process.argv.slice(2));
