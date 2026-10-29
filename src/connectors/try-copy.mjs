// Trying a story yourself (1.2 step 7, decided October 28, 2026). A code project gets one try copy: a git worktree
// of its repository in a folder beside the project's own (`<folder>-try` unless its settings name another), which
// the controller owns and keeps on a detached commit, so it never holds a branch that integration moves. Try it puts
// the copy on a story's candidate merged onto its line's current tip, as integration merges it, or on the candidate
// as built when that merge conflicts, and says which. The copy refuses to move while it holds the director's own
// edits, naming the files, unless the director discards them. Run starts the project's start command in the copy
// (a program and its arguments, run without a shell, as the build command is): in the built-in test sandbox where it
// lets a local port through, and otherwise on this computer once the director has confirmed that for the project.
// One Run at a time per project; trying another story stops it. Only the director's click starts it, never the
// autonomy policy or an agent. A controller stop ends it, and a restart records it as ended. Domain-free: any project
// on a repository gets the copy and Open folder, with or without a start command.
//
// The project's settings live on its record as `trying` ({ start, address, folder, runIn, outsideConfirmedAt });
// the copy's record is the setting `try:<projectId>`, and its Run's output a file in the data folder.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { recordProject } from '../core/projects.mjs';
import { subscriptionEnvironment } from '../adapters/process.mjs';
import { builtInSandboxCommand, readBuiltInSandboxStatus } from '../adapters/built-in-sandbox.mjs';
import { git } from './source-integration.mjs';
import { lineRepository, projectLine } from './source-lines.mjs';
import { installKey, npmCli } from './package-installs.mjs';
import { installsPackages, maxBuildArguments } from './source-profile.mjs';
import { projectSource } from './source-projects.mjs';
import { worktreeRepository } from './source-worktrees.mjs';

export const tryRunPlaces = ['built-in', 'computer'];
// How much of a Run's output the copy keeps: enough to read a server's start and its errors.
export const tryOutputBytes = 1024 * 1024;
const programName = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/;
// A local address the app printed: only this computer's, which Open may offer.
const localAddress = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s'"<>`]*)?/i;
const colors = /\x1b\[[0-9;?]*[A-Za-z]/g;

const failure = (message, status = 400, fields = {}) => Object.assign(new Error(message), { status, ...fields });
const settingId = projectId => `try:${projectId}`;
const sameFolder = (a, b) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
const inside = (folder, parent) => {
  const relative = path.relative(parent, folder);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// A project's Trying a story yourself settings, checked: the start command (a program's name and up to 19
// arguments, as the build command), an optional local address, the copy's folder and where Run runs.
export function validateTrySettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw failure('The try settings must be an object.');
  const problems = [];
  for (const key of Object.keys(settings))
    if (!['start', 'address', 'folder', 'runIn'].includes(key)) problems.push(`unknown field ${key}`);
  const { start = null, address = null, folder = null, runIn = 'built-in' } = settings;
  if (
    start !== null &&
    (!Array.isArray(start) ||
      !start.length ||
      start.length > maxBuildArguments + 1 ||
      typeof start[0] !== 'string' ||
      start[0].length > 64 ||
      !programName.test(start[0]) ||
      !start.slice(1).every(arg => typeof arg === 'string' && arg.length <= 500 && !/[\0-\x1f\x7f]/.test(arg)))
  )
    problems.push(`the start command must be a program's name and up to ${maxBuildArguments} arguments`);
  if (
    address !== null &&
    (typeof address !== 'string' || address.length > 300 || localAddress.exec(address)?.[0] !== address)
  )
    problems.push('the address must be an http address on this computer (localhost or 127.0.0.1)');
  if (folder !== null && (typeof folder !== 'string' || folder.length > 400 || !path.isAbsolute(folder)))
    problems.push("the try copy's folder must be an absolute path");
  if (!tryRunPlaces.includes(runIn)) problems.push('Run in must be the built-in sandbox or this computer');
  if (problems.length) throw failure(`The try settings are not valid: ${problems.join('; ')}.`);
  return { start: start && [...start], address, folder: folder && path.resolve(folder), runIn };
}

// The project's settings with their defaults, and where its copy lives: `<folder>-try` beside the project's folder.
export function trySettings(store, projectId, runtime) {
  const saved = store.project(projectId).trying || {},
    { root } = projectSource(store, projectId, runtime);
  return {
    start: saved.start || null,
    address: saved.address || null,
    folder: saved.folder || (root ? `${root}-try` : null),
    runIn: saved.runIn || 'built-in',
    outsideConfirmedAt: saved.outsideConfirmedAt || null,
  };
}

// Saves a project's settings. The copy's folder may not be the project's own, inside it or around it, since
// integration moves that folder's branch; it changes only while nothing runs, and the old copy stays where it was.
export function saveTrySettings(store, projectId, data, runtime) {
  const { root } = projectSource(store, projectId, runtime);
  if (!root) throw failure('Trying a story yourself needs a project on a git repository.');
  const settings = validateTrySettings(data);
  if (settings.folder && (inside(settings.folder, root) || inside(root, settings.folder)))
    throw failure("The try copy needs a folder of its own, outside the project's folder.");
  const project = store.project(projectId),
    before = trySettings(store, projectId, runtime);
  if (runningTry(runtime, projectId) && !sameFolder(before.folder, settings.folder || `${root}-try`))
    throw failure('Stop the running app before moving the try copy.', 409);
  // Choosing this computer again, or another start command, keeps an earlier confirmation; the director confirms
  // once per project.
  project.trying = {
    ...settings,
    ...(project.trying?.outsideConfirmedAt ? { outsideConfirmedAt: project.trying.outsideConfirmedAt } : {}),
  };
  store.putProject(project);
  return trySettings(store, projectId, runtime);
}

// Whether Run can use the built-in sandbox here: it lets a local port through on Windows, where its setup allows
// loopback (checked October 28: an app inside answers this computer's browser, and Stop ends it). Elsewhere, and
// where the sandbox is not set up, Run runs on this computer.
export const sandboxLetsPortsThrough = (status = readBuiltInSandboxStatus(), platform = process.platform) =>
  platform === 'win32' && status.state === 'ready';

// Where the next Run runs: the sandbox when the settings choose it and it lets a port through, else this computer.
export const runPlace = (settings, letsThrough = sandboxLetsPortsThrough()) =>
  settings.runIn === 'built-in' && letsThrough ? 'built-in' : 'computer';

// The copy's record, or null before the project's first Try it.
export const tryCopy = (store, projectId) => store.setting(settingId(projectId));

// What the dashboard reads: the settings, where the next Run runs, and the copy.
export function tryView(store, projectId, runtime, letsThrough = sandboxLetsPortsThrough()) {
  const settings = trySettings(store, projectId, runtime);
  return { settings, runsIn: runPlace(settings, letsThrough), copy: tryCopy(store, projectId) };
}

// Files the copy holds that it did not get from a story: the director's own edits, created files included. Ignored
// files, such as installed packages, are not edits.
export function copyEdits(folder) {
  return git(folder, ['status', '--porcelain', '--untracked-files=all'], { raw: true })
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(3).replace(/^"(.*)"$/, '$1'))
    .map(file => (file.includes(' -> ') ? file.split(' -> ')[1] : file));
}

// The story's candidate a Try it moves the copy to: an accepted candidate whose tests passed, with its commit.
function triedCandidate(store, task) {
  if (task.kind !== 'studio-development:change') throw failure('Try it works on a code story.');
  const pinned = task.sourceStage?.candidate,
    candidate = pinned && store.attempt(pinned.attemptId);
  if (!candidate || candidate.status !== 'accepted' || candidate.result?.outcome !== 'completed')
    throw failure('Try it is offered once the story has a candidate whose tests passed.', 409);
  if (!candidate.sourceCandidate?.commit)
    throw failure('This candidate was built before candidates were commits. Request a fresh candidate.', 409);
  return candidate;
}

// Moves the project's copy to a story's candidate merged onto its line's tip. A running app is stopped first. The
// copy holding the director's edits refuses, naming them, unless `discard` is set, which throws them away; ignored
// files such as installed packages stay. When the merge conflicts, the copy holds the candidate as built instead.
export async function tryStory(runtime, task, options = {}) {
  const projectId = recordProject(task);
  runtime.tryMoving ||= new Set();
  if (runtime.tryMoving.has(projectId)) throw failure('The try copy is already moving to a story.', 409);
  runtime.tryMoving.add(projectId);
  try {
    return await moveCopy(runtime, task, projectId, options);
  } finally {
    runtime.tryMoving.delete(projectId);
  }
}
async function moveCopy(runtime, task, projectId, { discard = false, by = { type: 'director' } }) {
  const store = runtime.store,
    { root, profile } = projectSource(store, projectId, runtime);
  if (!root) throw failure('Trying a story yourself needs a project on a git repository.');
  const candidate = triedCandidate(store, task),
    settings = trySettings(store, projectId, runtime),
    folder = settings.folder;
  if (inside(folder, root) || inside(root, folder))
    throw failure("The try copy needs a folder of its own, outside the project's folder.");
  const existing = fs.existsSync(folder);
  if (existing) {
    const owner = worktreeRepository(folder);
    if (!owner || !sameFolder(owner, fs.realpathSync.native(root)))
      throw failure(
        `${folder} holds something other than this project's try copy. Choose another folder in the project's settings.`,
        409,
      );
    const edits = copyEdits(folder);
    if (edits.length && !discard)
      throw failure(
        `The try copy holds your own edits: ${edits.slice(0, 20).join(', ')}${edits.length > 20 ? ` and ${edits.length - 20} more` : ''}. Keep them, or discard them and try this story.`,
        409,
        { edits },
      );
    await stopTry(runtime, projectId, 'Trying another story stopped it.');
    if (edits.length) {
      git(folder, ['reset', '--hard', '--quiet']);
      git(folder, ['clean', '-fd', '--quiet']);
    }
  }
  const line = projectLine(store, projectId, candidate.sourceChange?.base?.branch),
    repository = lineRepository(root, line),
    commit = candidate.sourceCandidate.commit;
  if (!existing) {
    fs.mkdirSync(path.dirname(folder), { recursive: true });
    git(root, ['worktree', 'add', '--detach', folder, repository.head]);
  } else git(folder, ['checkout', '--quiet', '--detach', repository.head]);
  // The same merge integration makes: the candidate's commit picked onto the line's tip.
  let merged = true,
    conflicts = [];
  try {
    git(folder, ['cherry-pick', '--no-commit', commit]);
    // A candidate already on the tip leaves nothing to commit.
    if (git(folder, ['diff', '--cached', '--name-only']))
      git(folder, [
        '-c',
        'user.name=Studio desk',
        '-c',
        'user.email=try@studio-desk.invalid',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        `Try it: ${task.title}`,
        '-m',
        `Studio-Try: ${candidate.id}`,
      ]);
  } catch {
    try {
      conflicts = git(folder, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    } catch {}
    git(folder, ['reset', '--hard', '--quiet']);
    git(folder, ['checkout', '--quiet', '--detach', commit]);
    merged = false;
  }
  const previous = tryCopy(store, projectId),
    record = {
      projectId,
      folder: fs.realpathSync.native(folder),
      taskId: task.id,
      title: task.title,
      candidateAttemptId: candidate.id,
      candidateCommit: commit,
      branch: repository.branch,
      tip: repository.head,
      commit: git(folder, ['rev-parse', 'HEAD']),
      merged,
      conflicts,
      // Packages stay between tries: the key of the lockfile they were installed from.
      packages: previous && sameFolder(previous.folder, folder) ? previous.packages || null : null,
      installs: installsPackages(profile),
      at: new Date().toISOString(),
      by,
      run: previous?.run && sameFolder(previous.folder, folder) ? previous.run : null,
    };
  store.putSetting(settingId(projectId), record);
  store.event(
    'try_moved',
    task.id,
    candidate.id,
    merged
      ? `The try copy holds this story's change merged onto ${repository.branch} at ${repository.head.slice(0, 7)}, as integrating it would merge it${discard ? ', after your edits there were discarded' : ''}.`
      : `This story's change conflicts with ${repository.branch} at ${repository.head.slice(0, 7)}${conflicts.length ? ` in ${conflicts.join(', ')}` : ''}, so the try copy holds the candidate as built.`,
  );
  return record;
}

// The process a start command runs as: npm, npx and node with the Node.js that runs the controller, as the build
// does, so no shell is needed to find them; any other program by its name from the PATH.
export function startCommand(start) {
  const [program, ...args] = start,
    purpose = 'the start command cannot run';
  if (program === 'node') return { executable: process.execPath, args };
  if (program === 'npm') return { executable: process.execPath, args: [npmCli(purpose), ...args] };
  if (program === 'npx')
    return { executable: process.execPath, args: [path.join(path.dirname(npmCli(purpose)), 'npx-cli.js'), ...args] };
  return { executable: program, args };
}

// The first address on this computer an app printed; 0.0.0.0 opens as localhost.
export function addressIn(text) {
  const found = localAddress.exec(String(text).replace(colors, ''))?.[0];
  return found ? found.replace('0.0.0.0', 'localhost').replace(/[.,;:)\]]+$/, '') : null;
}

const outputFile = (store, projectId) => path.join(store.directory, 'try', projectId, 'output.txt');
// A Run's output as the story shows it, read-only.
export function tryOutput(store, projectId) {
  const file = outputFile(store, projectId);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

export const runningTry = (runtime, projectId) => runtime.tryRuns?.get(projectId) || null;

// Starts the project's start command in its copy, at the director's click. Outside the sandbox the director confirms
// once per project (`confirmOutside`), since it runs the agents' code with their own access. Packages are installed
// first, from the copy's lockfile, when the project's settings install them and the lockfile changed since the last
// install; the install runs outside the sandbox with install scripts off, as the pipeline's does.
export function runTry(runtime, projectId, { confirmOutside = false } = {}) {
  const store = runtime.store,
    copy = tryCopy(store, projectId);
  if (!copy || !fs.existsSync(copy.folder)) throw failure('Try a story first: the copy holds nothing to run.', 409);
  if (runningTry(runtime, projectId)) throw failure('The app is already running. Stop it first.', 409);
  const settings = trySettings(store, projectId, runtime);
  if (!settings.start) throw failure("Name a start command in the project's settings first.", 409);
  const place = runPlace(settings, runtime.tryLetsPortsThrough ?? sandboxLetsPortsThrough());
  if (place === 'computer' && !settings.outsideConfirmedAt) {
    if (!confirmOutside)
      throw failure(
        "Run runs the agents' code on this computer, outside the sandbox, with your own access. Confirm once for this project to run it.",
        409,
        { confirm: 'outside' },
      );
    const project = store.project(projectId);
    project.trying = { ...(project.trying || {}), outsideConfirmedAt: new Date().toISOString() };
    store.putProject(project);
  }
  const file = outputFile(store, projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  const environment = subscriptionEnvironment();
  for (const key of Object.keys(environment)) if (/^STUDIO_/i.test(key)) delete environment[key];
  const start = runtime.tryStartCommand?.(settings.start) || startCommand(settings.start),
    command = place === 'built-in' ? builtInSandboxCommand({ root: copy.folder, command: start }) : start,
    key = copy.installs ? installKey(copy.folder) : null,
    install = key && key !== copy.packages,
    run = {
      id: `try-run-${Date.now().toString(36)}`,
      state: 'running',
      place,
      start: settings.start,
      address: settings.address,
      taskId: copy.taskId,
      commit: copy.commit,
      startedAt: new Date().toISOString(),
      by: { type: 'director' },
      ...(install ? { installing: true } : {}),
    },
    entry = { run, child: null, written: 0, stopping: null, ended: null };
  entry.ended = new Promise(resolve => (entry.resolve = resolve));
  runtime.tryRuns ||= new Map();
  runtime.tryRuns.set(projectId, entry);
  const save = () => {
    const current = tryCopy(store, projectId);
    if (current) store.putSetting(settingId(projectId), { ...current, run: { ...entry.run } });
  };
  const write = text => {
    if (entry.written >= tryOutputBytes) return;
    const chunk = Buffer.from(text).subarray(0, tryOutputBytes - entry.written);
    entry.written += chunk.length;
    fs.appendFileSync(file, chunk);
    if (entry.written >= tryOutputBytes) fs.appendFileSync(file, '\n[Studio desk kept the first 1 MiB of output.]\n');
  };
  const end = fields => {
    if (entry.run.state !== 'running') return;
    Object.assign(entry.run, { state: 'ended', endedAt: new Date().toISOString(), ...fields });
    delete entry.run.installing;
    runtime.tryRuns.delete(projectId);
    if (!runtime.closing) {
      save();
      store.event(
        'try_ended',
        copy.taskId,
        null,
        fields.stopped
          ? `The app was stopped: ${fields.stopped}`
          : fields.error
            ? `The app could not run: ${fields.error}`
            : `The app ended${fields.exitCode !== null && fields.exitCode !== undefined ? ` with exit code ${fields.exitCode}` : ''}.`,
      );
    }
    entry.resolve();
  };
  const launch = (executable, args, onExit) => {
    const child = spawn(executable, args, {
      cwd: copy.folder,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Elsewhere the app gets a process group of its own, so Stop ends everything it started.
      detached: process.platform !== 'win32',
    });
    entry.child = child;
    entry.run.pid = child.pid;
    const read = data => {
      const text = String(data);
      write(text);
      if (!entry.run.address && !entry.run.installing) {
        const address = addressIn(text);
        if (address) {
          entry.run.address = address;
          save();
        }
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', error =>
      end(entry.stopping ? { stopped: entry.stopping, exitCode: null } : { error: error.message, exitCode: null }),
    );
    child.on('close', (code, signal) => onExit(code, signal));
  };
  const startApp = () => {
    if (entry.stopping) return end({ stopped: entry.stopping, exitCode: null });
    delete entry.run.installing;
    write(`> ${settings.start.join(' ')}${place === 'built-in' ? ' (in the built-in sandbox)' : ''}\n`);
    save();
    launch(command.executable, command.args, (code, signal) =>
      end(entry.stopping ? { stopped: entry.stopping, exitCode: code } : { exitCode: code, signal: signal || null }),
    );
  };
  save();
  store.event(
    'try_run',
    copy.taskId,
    null,
    `You ran ${settings.start.join(' ')} in the try copy${place === 'built-in' ? ', in the built-in sandbox' : ', on this computer'}.`,
  );
  if (install) {
    const npm = runtime.packageInstallCommand || {
      executable: process.execPath,
      args: [npmCli(), 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'],
    };
    write('> npm ci (the packages changed since the last install)\n');
    launch(npm.executable, npm.args, code => {
      if (entry.stopping) return end({ stopped: entry.stopping, exitCode: null });
      if (code !== 0) return end({ error: 'npm ci failed; its output is above.', exitCode: code });
      const current = tryCopy(store, projectId);
      if (current) store.putSetting(settingId(projectId), { ...current, packages: key });
      startApp();
    });
  } else startApp();
  return { ...entry.run };
}

// Ends a process and everything it started. On Windows taskkill ends the tree; inside the built-in sandbox the
// sandbox account's own processes refuse it, and its job ends them with the runner. The process itself is ended too,
// for where taskkill cannot end it (a controller that itself runs in a sandbox, as the suite's verification does).
function endTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    // A process already ended is passed over.
    child.kill('SIGKILL');
  } else
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
}

// Stops a project's running app and waits for it to end.
export async function stopTry(runtime, projectId, reason = 'You stopped it.') {
  const entry = runningTry(runtime, projectId);
  if (!entry) return null;
  entry.stopping ||= reason;
  endTree(entry.child);
  await Promise.race([entry.ended, new Promise(resolve => setTimeout(resolve, 10000).unref())]);
  return { ...entry.run };
}

// A controller stop ends every running app, with nothing recorded (the store may be closing); the next start records
// each as ended.
export function endTryRuns(runtime) {
  for (const entry of runtime.tryRuns?.values() || []) {
    entry.stopping ||= 'The controller stopped.';
    endTree(entry.child);
  }
}

// At start: a Run recorded as running ended when the controller stopped.
export function recoverTryRuns(store) {
  for (const project of store.projects()) {
    const copy = tryCopy(store, project.id);
    if (copy?.run?.state !== 'running') continue;
    store.putSetting(settingId(project.id), {
      ...copy,
      run: { ...copy.run, state: 'ended', endedAt: new Date().toISOString(), stopped: 'The controller stopped.' },
    });
    store.event('try_ended', copy.taskId, null, 'The app ended when the controller stopped.');
  }
}

// Opens the copy's folder in the computer's file manager, at the director's click.
export function openTryFolder(store, projectId, open = openFolder) {
  const copy = tryCopy(store, projectId);
  if (!copy || !fs.existsSync(copy.folder)) throw failure('Try a story first: there is no copy to open.', 409);
  open(copy.folder);
  return { folder: copy.folder };
}
function openFolder(folder) {
  const [program, args] =
    process.platform === 'win32'
      ? ['explorer.exe', [folder]]
      : process.platform === 'darwin'
        ? ['open', [folder]]
        : ['xdg-open', [folder]];
  spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}
