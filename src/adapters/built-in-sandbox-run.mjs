// Runs one test command in the built-in sandbox (1.0.1), as a process of its own so the controller never
// loads the sandbox runtime. It writes the run's settings and instructions to a folder of their own, has
// the runtime run the launcher inside the sandbox, passes the output and exit code through, and then takes
// back the write access the runtime keeps on the copy between sessions. The helper's shared copy, the folders'
// see-only entries and the kept write access are Windows' own; macOS and Linux need none of them.
// Usage: node built-in-sandbox-run.mjs --root <the folder the tests may write> -- <executable> [args...]
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  builtInSandboxCommandLine,
  builtInSandboxDataFolder,
  builtInSandboxEnvironment,
  builtInSandboxFiles,
  builtInSandboxGitConfiguration,
  builtInSandboxPackages,
  builtInSandboxRuntimeEnvironment,
  builtInSandboxSecrets,
  builtInSandboxSessionFolder,
  builtInSandboxSettings,
  denyBuiltInSandboxData,
  denyBuiltInSandboxSecrets,
  openBuiltInSandboxPassThrough,
  shareBuiltInSandboxHelper,
  takeBuiltInSandboxSession,
} from './built-in-sandbox.mjs';

const windows = process.platform === 'win32';

const separator = process.argv.indexOf('--');
if (process.argv[2] !== '--root' || separator !== 4 || process.argv.length < 6) {
  console.error('Usage: node built-in-sandbox-run.mjs --root <folder> -- <executable> [args...]');
  process.exit(2);
}
const root = path.resolve(process.argv[3]),
  [executable, ...args] = process.argv.slice(5),
  files = builtInSandboxFiles(),
  launcher = fileURLToPath(new URL('./built-in-sandbox-launch.mjs', import.meta.url)),
  // Node as the sandbox account sees it: the installed folder, not a link to it (nvm's, for one).
  node = fs.realpathSync(process.execPath),
  runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sandbox-')),
  settings = path.join(runDirectory, 'settings.json'),
  instructions = path.join(runDirectory, `run-${randomUUID()}.json`),
  temporary = path.join(runDirectory, 'tmp'),
  // On macOS and Linux the tests run as the director's account, whose home folder the sandbox hides, so they get
  // a home of their own, as Windows' sandbox account has. The runtime refuses writes to any repository's
  // .git/hooks, so the repositories tests make take git's hook samples from an empty folder.
  home = path.join(temporary, 'home'),
  gitTemplates = path.join(runDirectory, 'git-templates');
if (windows) {
  shareBuiltInSandboxHelper(files);
  openBuiltInSandboxPassThrough(
    [root, path.dirname(node), path.dirname(launcher), runDirectory, ...builtInSandboxPackages(root)],
    files,
  );
  denyBuiltInSandboxSecrets(builtInSandboxSecrets(root));
  denyBuiltInSandboxData(builtInSandboxDataFolder(root));
} else for (const folder of [home, gitTemplates]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(
  settings,
  JSON.stringify(
    builtInSandboxSettings({
      root,
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
        : { TMPDIR: temporary, TMP: temporary, TEMP: temporary, HOME: home, GIT_TEMPLATE_DIR: gitTemplates }),
    },
  }),
);
// One of the computer's built-in sandbox sessions, which a sixth session at once on Windows could not set up (C-43):
// this run waits in turn for one, shared with every other copy of Studio desk here, npm run verify included. A run that
// gets none within the wait's bound ends as any other run does, saying why, with its folder and grant cleaned up.
let releaseSession = () => {};
if (windows)
  try {
    releaseSession = await takeBuiltInSandboxSession(builtInSandboxSessionFolder(files), {
      onWait: slots =>
        console.error(`Waiting for a built-in sandbox session: all ${slots} are in use on this computer.`),
    });
  } catch (error) {
    finish(error.message, 1);
  }
const child = spawn(
  process.execPath,
  [files.cli, '--settings', settings, '-c', builtInSandboxCommandLine(node, launcher, instructions)],
  {
    cwd: process.cwd(),
    env: windows ? process.env : builtInSandboxRuntimeEnvironment(process.env),
    stdio: 'inherit',
    windowsHide: true,
  },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => finish(`The sandbox runtime did not start: ${error.message}`, 1));
child.on('close', code => finish('', code ?? 1));

function finish(message, code) {
  if (message) console.error(message);
  // The runtime keeps write access on a folder it was given, to save granting it again; a copy is
  // tested once, so it is taken back now.
  if (windows) spawnSync(files.srtWin, ['acl', 'forget', root], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
  fs.rmSync(runDirectory, { recursive: true, force: true });
  releaseSession();
  process.exit(code);
}
