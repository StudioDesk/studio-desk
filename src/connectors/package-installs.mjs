// Installed packages for the source pipeline (Decision MP-026, v1.0 item 19b). Every copy the pipeline tests
// lives inside the controller's data folder (check copies under jobs/, worktrees under wt/), and Node,
// TypeScript, ESLint and Vite find packages by walking up from a file to the nearest node_modules. So one
// install at <data>/node_modules serves every tested copy, with no link or copy for git or the test
// sandbox to trip over. Before tests run, the controller makes sure that install matches the copy's lockfile,
// installing with `npm ci` and install scripts off, outside any sandbox; tests only read it. Stories cannot
// change package.json or the lockfile, so the install changes only after a hand commit. This file is also the
// step's own process, so cancellation, time limits and logs work as they do for every other step.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url),
  marker = '.studio-lockfile';

// The same package.json and lockfile always give the same key.
export function installKey(directory) {
  const manifest = path.join(directory, 'package.json'),
    lock = path.join(directory, 'package-lock.json');
  if (!fs.existsSync(manifest) || !fs.existsSync(lock)) return null;
  return createHash('sha256')
    .update(fs.readFileSync(manifest))
    .update('\0')
    .update(fs.readFileSync(lock))
    .digest('hex')
    .slice(0, 16);
}

function npmCli() {
  const base = path.dirname(process.execPath);
  for (const candidate of [
    path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ])
    if (fs.existsSync(candidate)) return candidate;
  throw new Error('npm was not found beside Node.js, so the packages cannot be installed.');
}

// The process that brings <data>/node_modules in line with a copy's lockfile, or null when the copy installs
// nothing: its profile does not install, or it holds no lockfile.
export function installStep(runtime, directory, installs) {
  if (!installs || !installKey(directory)) return null;
  const npm = runtime.packageInstallCommand || {
    executable: process.execPath,
    args: [npmCli(), 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'],
  };
  return {
    executable: process.execPath,
    args: [self, directory, runtime.store.directory, npm.executable, ...npm.args],
  };
}

// Runs a step's install before `next`, as its own phase of the attempt. A failure stops the attempt with
// the step's last line of explanation.
export function runInstallStep(runtime, entry, directory, installs, environment, next) {
  const step = installStep(runtime, directory, installs);
  if (!step) return next();
  const phase = runtime.startPhase(entry, 'install');
  let errors = '';
  runtime.runNative(entry, step.executable, step.args, '', () => null, {
    cwd: directory,
    environment,
    resultOnFailure: true,
    onComplete: (result, code) => {
      if (code !== 0) {
        runtime.store.finishPhase(phase, 'failed');
        throw new Error(lastLine(errors) || 'Installing the packages failed. See the attempt log.');
      }
      runtime.store.finishPhase(phase, 'succeeded');
      next();
    },
  });
  entry.child.stderr.on('data', text => (errors += text));
}

// Node gives a .js file the module type of the nearest package.json above it, and the default data folder sits
// inside the app, whose package.json makes .js files ES modules. A copy of a repository without a package.json of
// its own would take the app's and run its CommonJS as ES modules, so its tests fail only inside Studio desk. A
// package.json at the data folder's root, naming no type, gives such a copy Node's defaults, as anywhere else on the
// computer; a copy's own package.json still decides for it. One already there, in a data folder a person chose, stays.
export function packageBoundary(data) {
  const file = path.join(data, 'package.json');
  if (fs.existsSync(file)) return;
  const boundary = {
    private: true,
    description:
      "Studio desk's data folder. This file keeps the app's own package settings from applying to the copies tested here.",
  };
  fs.writeFileSync(file, JSON.stringify(boundary, null, 2) + '\n');
}

export const lastLine = text =>
  String(text || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1) || '';

// Windows refuses to rename a folder while anything holds a file inside it, as a virus scanner does for a moment
// after new files are written, more so on a busy computer. Like npm's own file layer, keep trying for a while,
// stopping early once `settled` says the rename is no longer needed. Returns whether this call renamed it.
const lockedCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
function renameWhenFree(from, to, { rename, wait, settled = () => false }) {
  const until = Date.now() + wait;
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    try {
      rename(from, to);
      return true;
    } catch (error) {
      if (settled()) return false;
      if (!lockedCodes.has(error.code) || Date.now() + delay > until) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

export function ensureInstall(directory, data, npm, log = console.log, { rename = fs.renameSync, wait = 30000 } = {}) {
  const key = installKey(directory);
  if (!key) throw new Error('The copy holds no package.json and package-lock.json to install from.');
  const relative = path.relative(fs.realpathSync(data), fs.realpathSync(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(
      "The tested copy is outside the controller's data folder, so it cannot use the installed packages.",
    );
  const modules = path.join(data, 'node_modules'),
    current = () => {
      try {
        return fs.readFileSync(path.join(modules, marker), 'utf8');
      } catch {
        return null;
      }
    };
  if (current() === key) return log(`Using the packages installed for this lockfile (${key}).`);
  const staging = path.join(data, `.install-${key}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const file of ['package.json', 'package-lock.json'])
      fs.copyFileSync(path.join(directory, file), path.join(staging, file));
    log(`Installing the packages for this lockfile (${key}) with npm ci, install scripts off…`);
    const started = Date.now(),
      result = spawnSync(npm[0], npm.slice(1), {
        cwd: staging,
        stdio: 'inherit',
        windowsHide: true,
        timeout: 10 * 60 * 1000,
      });
    if (result.status !== 0 || !fs.existsSync(path.join(staging, 'node_modules', '.package-lock.json')))
      throw new Error(
        `Installing the packages failed (${result.error ? result.error.message : `npm exited with ${result.status ?? result.signal}`}). Check that this computer can reach the npm registry, then retry.`,
      );
    fs.writeFileSync(path.join(staging, 'node_modules', marker), key);
    // Another step may have finished the same install meanwhile; otherwise the new install replaces the old.
    const done = () => current() === key;
    if (!done()) {
      const old = path.join(data, `.node_modules-old-${process.pid}`),
        moved = fs.existsSync(modules) && renameWhenFree(modules, old, { rename, wait, settled: done });
      try {
        renameWhenFree(path.join(staging, 'node_modules'), modules, { rename, wait, settled: done });
      } catch (error) {
        // Put the previous install back rather than leave none.
        if (moved && !fs.existsSync(modules)) renameWhenFree(old, modules, { rename, wait });
        throw error;
      }
      if (moved) fs.rmSync(old, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    log(`Installed in ${Math.round((Date.now() - started) / 1000)} s.`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const [directory, data, ...npm] = process.argv.slice(2);
  try {
    ensureInstall(directory, data, npm);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
