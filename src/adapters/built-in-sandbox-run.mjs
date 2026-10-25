// Runs one test command in the built-in sandbox (1.0.1), as a process of its own so the controller never
// loads the sandbox runtime. It writes the run's settings and instructions to a folder of their own, has
// the runtime run the launcher inside the sandbox, passes the output and exit code through, and then takes
// back the write access the runtime keeps on the copy between sessions.
// Usage: node built-in-sandbox-run.mjs --root <the folder the tests may write> -- <executable> [args...]
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  builtInSandboxCommandLine,
  builtInSandboxEnvironment,
  builtInSandboxFiles,
  builtInSandboxSettings,
} from './built-in-sandbox.mjs';

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
  instructions = path.join(runDirectory, `run-${randomUUID()}.json`);
fs.writeFileSync(
  settings,
  JSON.stringify(
    builtInSandboxSettings({
      root,
      nodeDirectory: path.dirname(node),
      launcherDirectory: path.dirname(launcher),
      runDirectory,
    }),
  ),
);
fs.writeFileSync(
  instructions,
  JSON.stringify({
    cwd: process.cwd(),
    executable: executable === process.execPath ? node : executable,
    args,
    env: builtInSandboxEnvironment(process.env),
  }),
);
const child = spawn(
  process.execPath,
  [files.cli, '--settings', settings, '-c', builtInSandboxCommandLine(node, launcher, instructions)],
  { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => finish(`The sandbox runtime did not start: ${error.message}`, 1));
child.on('close', code => finish('', code ?? 1));

function finish(message, code) {
  if (message) console.error(message);
  // The runtime keeps write access on a folder it was given, to save granting it again; a copy is
  // tested once, so it is taken back now.
  spawnSync(files.srtWin, ['acl', 'forget', root], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
  fs.rmSync(runDirectory, { recursive: true, force: true });
  process.exit(code);
}
