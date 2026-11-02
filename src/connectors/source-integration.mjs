// Controller-owned finishing for an approved source integration (MP-016): merge the reviewed
// candidate commit onto the current tip in an integration worktree, format the changed files,
// run the full suite there, commit, then fast-forward the development copy to that commit.
// Nothing here is reachable by a dispatched employee, and every command is an argument array.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { command, subscriptionEnvironment } from '../adapters/process.mjs';
import { candidateTestCommand, sandboxLabel } from '../adapters/source-test-sandbox.mjs';
import { hash } from '../core/contracts.mjs';
import { runGit, runGitAsync } from '../git.mjs';
import { releaseTestTurn, testTurnResource } from '../core/test-turn.mjs';
import { sourcePlan, testOutput, testPhaseEvidence } from './source-checks.mjs';
import { installsPackages, studioDeskProfile } from './source-profile.mjs';
import { installStep, lastLine } from './package-installs.mjs';
import { buildCommand, buildPassed, buildTail, buildText, buildTimeoutMs, changedByBuild } from './source-build.mjs';

// Studio desk's formatter. Keep in step with the "format" script in package.json (checked by a test).
export const sourceFormatter = studioDeskProfile.formatter.package;
// How long the controller's own install and test steps may run; a candidate's tests use the same
// limits (src/adapters/source-change.mjs).
export const installTimeoutMs = 10 * 60 * 1000,
  testTimeoutMs = 15 * 60 * 1000;
const formatTimeoutMs = 5 * 60 * 1000,
  logLimit = 192 * 1024;

// The native resolver also expands Windows short names, but sandboxes (Codex MXC) can deny it.
const realpath = value => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return fs.realpathSync(value);
  }
};
const samePath = (a, b) => {
  const resolve = value => path.resolve(realpath(value));
  return process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
};
// The connectors' git: the controller's own git (src/git.mjs), with exact pathspecs, the repository's hooks and
// fsmonitor off, and long paths on. check-ignore matches each path against the ignore rules as written, and only its
// check for tracked files reads [ ] as a glob. Output is trimmed unless raw is set.
export function git(root, args, { raw = false } = {}) {
  return runGit(root, args, { raw });
}
// The same answer without holding the controller's thread, for reads that ask git many things (C-20).
export function gitAsync(root, args, { raw = false } = {}) {
  return runGitAsync(root, args, { raw });
}
// The live source must be the root of a git repository on a branch with a commit identity.
// A story starts only from a clean tree; integration fast-forwards, and git refuses that
// rather than overwrite uncommitted edits, so it leaves other local edits alone. Work on a
// release line that is not checked out (src/connectors/source-lines.mjs) needs no branch
// checked out (attached false; branch is then null when HEAD is detached).
// Its answers take four git calls, where they took six: the top folder comes with the commit, and both identity settings
// in one read. Integrations, carries and story starts each ask it, and its calls were a third of the synchronous git
// time in the integration tests (C-20, November 2). A repository with no commit yet still answers as it did.
export function repositoryState(root, action = 'integrating source', { clean = true, attached = true } = {}) {
  let top, head;
  try {
    [top, head] = git(root, ['rev-parse', '--show-toplevel', 'HEAD']).split('\n');
  } catch {
    try {
      top = git(root, ['rev-parse', '--show-toplevel']);
    } catch (error) {
      throw new Error(
        gitRefusal(error, 'the live source') || `The live source must be a git repository before ${action}.`,
      );
    }
  }
  if (!samePath(top, root)) throw new Error('The live source must be the root of its git repository.');
  let branch = null;
  try {
    branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
  } catch {
    if (attached) throw new Error(`Check out a branch before ${action}; HEAD is detached.`);
  }
  if (clean && git(root, ['status', '--porcelain', '--untracked-files=no']))
    throw new Error(`Commit or stash tracked changes in the live source before ${action}.`);
  // Each setting's last value counts, as `git config <key>` reads it: the repository's own after the global one. An
  // empty value is listed as the key alone, and counts as unset, as it did.
  const identity = {};
  try {
    for (const line of git(root, ['config', '--get-regexp', '^user\\.(name|email)$']).split('\n')) {
      const at = line.indexOf(' ');
      if (line) identity[at > 0 ? line.slice(0, at) : line.trim()] = at > 0 ? line.slice(at + 1).trim() : '';
    }
  } catch {
    // Neither is set.
  }
  if (!identity['user.name'] || !identity['user.email'])
    throw new Error(`Configure git user.name and user.email before ${action}.`);
  return { branch, head: head ?? git(root, ['rev-parse', 'HEAD']) };
}
// What to say when git refuses a folder for a reason other than that no repository is there (another user's
// repository without safe.directory, a broken configuration, no git at all), in git's own words; null otherwise.
export function gitRefusal(error, folder = 'this folder') {
  const reason = error.message.replace(/^git [\w-]+ failed: /, '').trim();
  if (/ENOENT/.test(reason)) return 'Git could not be started. Install git, or put it on the PATH, then try again.';
  return !reason || /not a git repository/i.test(reason)
    ? null
    : `Git refused ${folder}: ${reason.replace(/^fatal: /, '')}`;
}
// Stages the files that exist; committing the listed paths also records the deleted ones.
export function stageFiles(root, files) {
  const present = files.filter(file => fs.existsSync(path.join(root, file)));
  if (present.length) git(root, ['add', '--', ...present]);
}
export function commitIntegration(root, files, message, directory) {
  const file = path.join(directory, 'commit-message.txt');
  fs.writeFileSync(file, message);
  stageFiles(root, files);
  git(root, ['commit', '--no-verify', '--file', file, '--', ...files]);
  return git(root, ['rev-parse', 'HEAD']);
}
// A commit that landed before its journal was updated is recognized by this trailer.
export const integrationTrailer = journal => `Studio-Integration: ${journal.id}`;
export function committedIntegration(root, journal) {
  try {
    const head = git(root, ['rev-parse', 'HEAD']);
    return head !== journal.repository.head &&
      git(root, ['log', '-1', '--format=%B']).includes(integrationTrailer(journal))
      ? head
      : null;
  } catch {
    return null;
  }
}

function npxCli() {
  const base = path.dirname(process.execPath);
  for (const candidate of [
    path.join(base, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ])
    if (fs.existsSync(candidate)) return candidate;
  throw new Error('npx was not found beside Node.js, so the formatter cannot run.');
}
// On Windows a process that has already exited is passed over: taskkill finds a tree by its root's ID, which may
// belong to another process by now (C-41). Elsewhere the process group outlives its first process and its ID is not
// reused while any of it runs, so what is left of the tree is still ended.
export function stopProcess(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 });
    } else process.kill(-child.pid, 'SIGKILL');
  } catch {}
}
export function stopIntegrationProcess(runtime) {
  const child = runtime.integrationProcess,
    turn = runtime.integrationTurn;
  if (!child && !turn?.waiting) return;
  // Shutdown is an observation, not confirmation of successful process completion.
  if (runtime.closing)
    for (const phase of runtime.integrationPhases || [])
      runtime.store.finishPhase(phase, 'interrupted', {
        ...phase.evidence?.(),
        timing: 'shutdown-requested',
        completionConfirmed: false,
      });
  // A verification waiting for the computer's test turn has no process: it stops waiting and holds no turn.
  if (!child) return turn.waiting();
  // Same trusted test seam the orchestrator uses for single-process fixtures inside a sandbox.
  if (runtime.fixtureProcessTermination) runtime.fixtureProcessTermination({ child }, true);
  else stopProcess(child);
  // A stopping controller gives back the turn its test run held while the records are open; the run may end after
  // they close.
  if (runtime.closing) turn?.release();
}
// The computer's turn for full test suites (core/test-turn.mjs), taken for the verification's install, build and test
// run under the journal's identity, which holds the project's source too; each of those steps' time limits starts
// once the turn is held. Integrations,
// carries and releases all verify here. While it waits, the journal records { reason, since, holder } as a waiting
// attempt does, until the turn is taken. It waits outside the attempts' first-come queue, which serves attempts only:
// when a lease change frees the turn, it is tried once the change has settled and before that queue is served, since
// it holds its project's source meanwhile. Resolves with the held turn; a controller stop ends the wait holding none.
async function takeVerificationTurn(runtime, journal) {
  const store = runtime.store,
    stopped = () => new Error('The controller stopped while the verification waited for its turn to run the tests.');
  if (runtime.closing) throw stopped();
  const turn = {
      held: false,
      waiting: null,
      // Gives the turn back once, when the run ends or the controller stops.
      release() {
        if (runtime.integrationTurn === turn) runtime.integrationTurn = null;
        if (!turn.held) return;
        turn.held = false;
        releaseTestTurn(store, journal.id);
      },
    },
    claim = () => {
      try {
        store.claim([testTurnResource], journal.id);
        return null;
      } catch (error) {
        if (error.conflict) return error.conflict;
        throw error;
      }
    },
    conflict = claim();
  runtime.integrationTurn = turn;
  turn.held = !conflict;
  if (turn.held) return turn;
  return new Promise((resolve, reject) => {
    let tried = false;
    const settle = error => {
      unwatch();
      turn.waiting = null;
      delete journal.testTurn;
      recordTestTurn(store, journal);
      if (error) {
        turn.release();
        reject(error);
      } else {
        turn.held = true;
        resolve(turn);
      }
    };
    const retry = () => {
      tried = false;
      if (!turn.waiting) return;
      let conflict;
      try {
        conflict = claim();
      } catch (error) {
        return settle(error); // The records closed with the controller.
      }
      if (!conflict) return settle();
      // The record names the current holder; its wait and event stay as they began.
      if (conflict.ownerAttemptId === journal.testTurn.holder) return;
      Object.assign(journal.testTurn, { reason: conflict.reason, holder: conflict.ownerAttemptId });
      recordTestTurn(store, journal);
    };
    // A lease change may come inside a transaction, so the turn is tried once the change has settled.
    const unwatch = store.watchLeases(() => {
      if (tried || !turn.waiting) return;
      tried = true;
      queueMicrotask(retry);
    });
    turn.waiting = () => settle(stopped());
    journal.testTurn = { reason: conflict.reason, since: new Date().toISOString(), holder: conflict.ownerAttemptId };
    recordTestTurn(store, journal);
    store.event('test_turn', journal.reviewTaskId, journal.reviewAttemptId, conflict.reason);
  });
}
// Keeps a journal's wait for the test turn where the journal is kept, found by its identity as store.resourceConflict
// reads it: a release's on its milestone, an integration's or a carry's on its review. A journal kept nowhere (a
// test's own) waits in memory only, as does one whose records closed with the controller.
function recordTestTurn(store, journal) {
  try {
    const release = /^source-release:(.+):(milestone-[\w-]+)$/.exec(journal.id);
    let kept, save;
    if (release) {
      const milestones = store.setting('milestones:' + release[1], []);
      kept = milestones.find(item => item.id === release[2])?.release;
      save = () => store.putSetting('milestones:' + release[1], milestones);
    } else {
      const review = store.attempt(journal.reviewAttemptId);
      kept = [review.sourceIntegration, ...(review.sourceCarries || [])].find(item => item?.id === journal.id);
      save = () => store.updateAttempt(review);
    }
    if (kept?.id !== journal.id || (!journal.testTurn && !kept.testTurn)) return;
    if (journal.testTurn) kept.testTurn = { ...journal.testTurn };
    else delete kept.testTurn;
    save();
  } catch {}
}
// One occurrence per actual step. Journal/lease identity remains unchanged on retries;
// integrationOccurrenceId separates their observations without changing ownership.
export function observeIntegrationPhase(runtime, journal, phaseId, operation) {
  const phase = runtime.store.startPhase({ id: journal.reviewAttemptId, taskId: journal.reviewTaskId }, phaseId, {
    integrationOccurrenceId: journal.phaseOccurrenceId,
    candidateAttemptId: journal.candidateAttemptId,
    reviewAttemptId: journal.reviewAttemptId,
    integrationId: journal.id,
  });
  (runtime.integrationPhases ||= new Set()).add(phase);
  const finish = (value, error) => {
    if (error && !error.verification)
      error.verification = {
        phaseId,
        ...phase.evidence?.(),
        checks: [{ name: phaseId, status: 'fail', evidence: error.message.slice(0, 1000) }],
      };
    if (!runtime.closing)
      runtime.store.finishPhase(phase, error || value?.passed === false ? 'failed' : 'succeeded', {
        ...(phaseId === 'integration.verification' ? { totals: null, tapDurationMs: null } : {}),
        ...(error ? { error: error.message } : {}),
        ...phase.evidence?.(),
        ...error?.phaseEvidence,
        ...(value?.totals !== undefined ? { totals: value.totals, tapDurationMs: value.tapDurationMs ?? null } : {}),
      });
    runtime.integrationPhases.delete(phase);
    if (error) throw error;
    return value;
  };
  try {
    const result = operation(phase);
    if (result?.then)
      return result.then(
        value => finish(value),
        error => finish(null, error),
      );
    return finish(result);
  } catch (error) {
    return finish(null, error);
  }
}
// record names the file that keeps the whole of stdout as it arrives (testOutput).
function run(runtime, executable, args, { cwd, environment, timeoutMs, phase, record = null }) {
  return new Promise((resolve, reject) => {
    const [file, argv] = command(executable, args),
      child = spawn(file, argv, {
        cwd,
        env: environment,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    runtime.integrationProcess = child;
    const stdout = testOutput(logLimit, record);
    let stderr = '',
      timedOut = false,
      observedExit = null,
      observedSignal = null;
    if (phase)
      phase.evidence = () => ({
        ...(phase.payload.phaseId === 'integration.verification' ? testPhaseEvidence(stdout.text()) : {}),
        timedOut,
        exitCode: observedExit,
        signal: observedSignal,
      });
    child.stdout.on('data', chunk => {
      stdout.add(chunk);
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < logLimit) stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stopIntegrationProcess(runtime);
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      if (runtime.integrationProcess === child) runtime.integrationProcess = null;
    };
    child.on('error', error => {
      done();
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      observedExit = exitCode;
      observedSignal = signal;
      done();
      resolve({ exitCode, signal, timedOut, stdout: stdout.text(), stderr });
    });
  });
}

// The candidate commit holds exactly the reviewed changes on the story's base: its parent is the
// base commit, it adds, modifies or deletes only the reviewed files, and each file it keeps is the
// reviewed artifact as git stores it. changes: [{ path, file, status }], where status is A, M or D
// and file is the reviewed artifact on disk (none for a deleted file).
export function verifyCandidateCommit(root, commit, base, changes) {
  try {
    git(root, ['cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    throw new Error('The candidate commit is missing from the repository. Request a fresh candidate.');
  }
  const matches = () => {
    const [, parent, ...others] = git(root, ['rev-list', '--parents', '-n', '1', commit]).split(' ');
    if (parent !== base || others.length) return false;
    const fields = git(root, ['diff', '--name-status', '--no-renames', '-z', parent, commit], { raw: true })
        .split('\0')
        .filter(Boolean),
      changed = [];
    for (let i = 0; i < fields.length; i += 2) changed.push(`${fields[i]} ${fields[i + 1]}`);
    return (
      changed.sort().join('\n') ===
        changes
          .map(item => `${item.status} ${item.path}`)
          .sort()
          .join('\n') &&
      changes.every(
        item =>
          item.status === 'D' ||
          git(root, ['rev-parse', `${commit}:${item.path}`]) ===
            git(root, ['hash-object', `--path=${item.path}`, item.file]),
      )
    );
  };
  let same = false;
  try {
    same = matches();
  } catch {}
  if (!same) throw new Error('The candidate commit does not match the reviewed edits. Request a fresh candidate.');
}

// Moves the development copy's branch to the verified integration commit. Nothing is written when
// the branch has moved or the changed files hold local edits; git itself refuses before writing
// when local edits or untracked files would be overwritten. A failure part-way (a locked file on
// Windows) is marked partial, because it may leave files behind.
export function fastForward(root, journal) {
  const { branch, head } = repositoryState(root, 'integrating source', { clean: false }),
    files = journal.changes.map(item => item.path),
    edited = () => statusPaths(root, files);
  if (branch !== journal.repository.branch || head !== journal.repository.head)
    throw new Error(
      `${journal.repository.branch} moved during verification${branch === journal.repository.branch ? '' : ` (${branch} is checked out)`}. Approve integration again to merge onto the current tip.`,
    );
  const local = edited();
  if (local.length)
    throw new Error(
      `Commit or stash local edits to ${local.join(', ')} in the development copy, then approve integration again.`,
    );
  try {
    git(root, ['merge', '--ff-only', '--quiet', journal.commit]);
  } catch (error) {
    throw Object.assign(
      new Error(`git did not fast-forward the development copy. ${error.message.replace(/^git merge failed: /, '')}`),
      { partial: landed(root, journal.commit) || edited().length > 0 },
    );
  }
}
// Whether a commit has reached the development copy's checked-out branch, or another ref (a line's branch).
export function landed(root, commit, ref = 'HEAD') {
  try {
    git(root, ['merge-base', '--is-ancestor', commit, ref]);
    return true;
  } catch {
    return false;
  }
}
// What landed on the line between the commit a candidate was built and tested on and the one its integration merged
// it onto: how many commits, and the stories among them by their integration commits' "Change:" line. Null when the
// line has not moved, or git cannot say.
export function landedSince(root, journal) {
  try {
    const base = git(root, ['rev-parse', `${journal.candidateCommit}^`]);
    if (base === journal.repository.head) return null;
    const commits = git(root, ['log', '--format=%H%x00%B%x01', `${base}..${journal.repository.head}`], { raw: true })
      .split('\x01')
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => {
        const [commit, message = ''] = entry.split('\x00');
        return { commit, storyId: /^Change: (T-[\w-]+) /m.exec(message)?.[1] ?? null };
      });
    if (!commits.length) return null;
    return {
      commits: commits.length,
      stories: commits
        .filter(item => item.storyId)
        .reverse()
        .map(item => ({ storyId: item.storyId, commit: item.commit })),
    };
  } catch {
    return null;
  }
}
// Paths git reports as changed or untracked, optionally limited to some files.
export function statusPaths(root, files = []) {
  return git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...files], { raw: true })
    .split('\0')
    .filter(Boolean)
    .map(entry => entry.slice(3));
}

// Builds the integration in its worktree, checked out at the tip it will fast-forward from:
// merges the candidate commit onto it (three-way), formats only the changed files that remain
// and runs the full suite on the result. Nothing outside the worktree changes.
// The profile (the candidate's) names the formatter, or none, and the snapshot the suite runs on; the
// candidate's recorded configuration names the test sandbox, the one its own tests ran in.
export async function verifyIntegration(runtime, journal, directory, configuration, profile = studioDeskProfile) {
  try {
    const startedAt = new Date().toISOString(),
      formatter = profile.formatter,
      worktree = journal.worktree,
      files = journal.changes.map(item => item.path),
      // A deleted file has no afterHash; the merge removes it and there is nothing to format.
      kept = journal.changes.filter(item => item.afterHash !== null).map(item => item.path);
    observeIntegrationPhase(runtime, journal, 'integration.merge', () => {
      try {
        git(worktree, ['cherry-pick', '--no-commit', journal.candidateCommit]);
      } catch (error) {
        let conflicts = [];
        try {
          conflicts = git(worktree, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
        } catch {}
        // A conflict keeps its files, so the story can be merged onto the current source (1.1 step 3).
        throw Object.assign(
          new Error(
            conflicts.length
              ? `The candidate conflicts with changes integrated since its base, in ${conflicts.join(', ')}. Use Merge onto the current source: its editor resolves the conflicts in the change it already made.`
              : `The candidate could not be merged onto the current source. ${error.message}`,
          ),
          conflicts.length ? { conflicts } : {},
        );
      }
    });
    const environment = subscriptionEnvironment();
    for (const key of Object.keys(environment)) if (/^STUDIO_/i.test(key)) delete environment[key];
    if (kept.length && (formatter || runtime.sourceFormatCommand)) {
      await observeIntegrationPhase(runtime, journal, 'integration.format', async phase => {
        const format = runtime.sourceFormatCommand || {
            executable: npxCli(),
            args: ['--yes', formatter.package, ...formatter.args],
          },
          formatted = await run(runtime, format.executable, [...format.args, ...kept], {
            cwd: worktree,
            environment,
            timeoutMs: formatTimeoutMs,
            phase,
          });
        fs.writeFileSync(path.join(directory, 'format-output.txt'), formatted.stdout + formatted.stderr);
        if (formatted.exitCode !== 0 || formatted.timedOut)
          throw Object.assign(
            new Error(
              `The formatter did not complete: ${formatted.timedOut ? 'time limit reached' : formatted.stderr.trim().slice(0, 500) || 'exit ' + formatted.exitCode}`,
            ),
            {
              verification: {
                phaseId: 'integration.format',
                timedOut: formatted.timedOut,
                exitCode: formatted.exitCode,
                signal: formatted.signal,
                checks: [
                  {
                    name: 'Integration formatter',
                    status: 'fail',
                    evidence: formatted.timedOut ? 'Formatter time limit reached.' : `Exit ${formatted.exitCode}.`,
                  },
                ],
              },
            },
          );
        const outside = statusPaths(worktree).filter(file => !files.includes(file));
        if (outside.length) throw new Error(`The formatter changed ${outside.join(', ')}, outside the reviewed files.`);
      });
    } else
      fs.writeFileSync(
        path.join(directory, 'format-output.txt'),
        kept.length ? "The project's source profile names no formatter.\n" : 'The change only deletes files.\n',
      );
    const outside = statusPaths(worktree).filter(file => !files.includes(file));
    if (outside.length) throw new Error(`The formatter changed ${outside.join(', ')}, outside the reviewed files.`);
    if (files.some(file => fs.existsSync(path.join(worktree, file)) !== kept.includes(file)))
      throw new Error('The merged source does not hold exactly the reviewed files.');
    // The verification holds the computer's test turn from its install through its tests (C-10's interim, November
    // 2026): the packages are installed for one lockfile at a time in the data folder, so another line's install never
    // replaces them under a suite that is running. The turn is given back however the verification ends.
    const verifyHeld = async phase => {
      const plan = sourcePlan(worktree, profile);
      // The merged source gets its installed packages first (MP-026), outside the test sandbox.
      const install = installStep(runtime, worktree, installsPackages(profile));
      if (install) {
        const installed = await run(runtime, install.executable, install.args, {
          cwd: worktree,
          environment,
          timeoutMs: installTimeoutMs,
          phase,
        });
        fs.writeFileSync(path.join(directory, 'install-output.txt'), installed.stdout + installed.stderr);
        if (installed.exitCode !== 0 || installed.timedOut)
          throw Object.assign(
            new Error(
              installed.timedOut
                ? 'Installing the packages ran out of time.'
                : lastLine(installed.stderr) || 'Installing the packages failed.',
            ),
            {
              verification: {
                phaseId: 'integration.verification',
                timedOut: installed.timedOut,
                exitCode: installed.exitCode,
                signal: installed.signal,
                checks: [
                  {
                    name: 'Installed packages',
                    status: 'fail',
                    evidence: installed.timedOut ? 'Install time limit reached.' : `Exit ${installed.exitCode}.`,
                  },
                ],
              },
            },
          );
      }
      // The project's build, when its settings name one, runs before the tests, wrapped as they are (1.1). A failing
      // build stops the verification there; a build must leave the verified source as it was.
      const build = buildCommand(profile);
      let built = null;
      if (build) {
        const wrapped = candidateTestCommand({ root: worktree, command: build }, configuration);
        let result;
        try {
          result = await run(runtime, wrapped.executable, wrapped.args, {
            cwd: worktree,
            environment,
            timeoutMs: buildTimeoutMs,
            phase,
          });
        } catch (error) {
          throw new Error(
            `The build command could not start: ${error.message}. npm, npx and node run with the controller's Node.js; another program must be on the PATH.`,
          );
        }
        fs.writeFileSync(path.join(directory, 'build-output.txt'), result.stdout + result.stderr);
        const passed = buildPassed(result);
        built = {
          name: 'Integration build',
          status: passed ? 'pass' : 'fail',
          evidence: `${buildText(profile)}, ${sandboxLabel(configuration)}: ${result.timedOut ? 'time limit reached' : `exit ${result.exitCode ?? result.signal}`}.${passed ? '' : `\n${buildTail(result.stdout + result.stderr)}`}`,
        };
        if (!passed)
          throw Object.assign(
            new Error(
              result.timedOut
                ? 'The build ran out of time.'
                : `The build failed: ${lastLine(result.stderr) || lastLine(result.stdout) || 'exit ' + (result.exitCode ?? result.signal)}`,
            ),
            {
              verification: {
                phaseId: 'integration.verification',
                timedOut: result.timedOut,
                exitCode: result.exitCode,
                signal: result.signal,
                checks: [built],
              },
            },
          );
        if (sourcePlan(worktree, profile).sourceHash !== plan.sourceHash) throw new Error(changedByBuild);
      }
      const test = runtime.sourceCheckCommand || candidateTestCommand(plan, configuration);
      // Same command-local test profile and copied-harness marker as candidate tests.
      environment.STUDIO_MODEL_FREE_LEAF_FIXTURES = '1';
      const tested = await run(runtime, test.executable, test.args, {
        cwd: worktree,
        environment,
        timeoutMs: testTimeoutMs,
        phase,
        record: path.join(directory, 'test-output-full.txt'),
      });
      fs.writeFileSync(path.join(directory, 'test-output.txt'), tested.stdout);
      fs.writeFileSync(path.join(directory, 'test-errors.txt'), tested.stderr);
      if (sourcePlan(worktree, profile).sourceHash !== plan.sourceHash)
        throw Object.assign(new Error('A test changed the verified source.'), {
          phaseEvidence: testPhaseEvidence(tested.stdout),
        });
      const { totals, tapDurationMs, failedTests } = testPhaseEvidence(tested.stdout);
      const passed =
        !!totals &&
        tested.exitCode === 0 &&
        !tested.signal &&
        !tested.timedOut &&
        totals.fail === 0 &&
        totals.cancelled === 0 &&
        totals.skipped === 0 &&
        totals.todo === 0 &&
        totals.pass === totals.tests;
      return {
        passed,
        phaseId: 'integration.verification',
        failedTests,
        checks: [
          ...(built ? [built] : []),
          {
            name: 'Integration Node test suite',
            status: passed ? 'pass' : 'fail',
            evidence: tested.timedOut
              ? 'Verification time limit reached.'
              : `Exit ${tested.exitCode}; ${JSON.stringify(totals)}; ran ${runtime.sourceCheckCommand ? 'as a protocol fixture' : sandboxLabel(configuration)}.`,
          },
        ],
        formatter: runtime.sourceFormatCommand ? 'formatter fixture' : formatter?.package || 'none',
        fixture: !!(runtime.sourceFormatCommand || runtime.sourceCheckCommand),
        sourceHash: plan.sourceHash,
        files: files.map(file => ({
          path: file,
          integratedHash: kept.includes(file) ? hash(fs.readFileSync(path.join(worktree, file))) : null,
        })),
        totals,
        tapDurationMs,
        exitCode: tested.exitCode,
        signal: tested.signal,
        timedOut: tested.timedOut,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    };
    return await observeIntegrationPhase(runtime, journal, 'integration.verification', async phase => {
      const turn = await takeVerificationTurn(runtime, journal);
      try {
        return await verifyHeld(phase);
      } finally {
        turn.release();
      }
    });
  } catch (error) {
    return {
      passed: false,
      error: error.message,
      ...error.verification,
      ...(error.conflicts ? { conflicts: error.conflicts } : {}),
    };
  }
}
