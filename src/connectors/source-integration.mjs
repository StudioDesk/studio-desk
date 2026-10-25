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
import { sourcePlan, testPhaseEvidence } from './source-checks.mjs';
import { installsPackages, studioDeskProfile } from './source-profile.mjs';
import { installStep, lastLine } from './package-installs.mjs';

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
// Every pathspec is the exact path, never a glob or magic pattern: story paths may hold [ ] and
// ( ), so src/[A]GENTS.md must not match src/AGENTS.md. A folder still matches the files under it.
// check-ignore refuses any pathspec magic, --literal-pathspecs included; it matches each path
// against the ignore rules as written, and only its check for tracked files reads [ ] as a glob.
// Git for Windows stops at 260-character paths unless core.longpaths is set; candidate
// copies sit deep inside job folders. Other platforms ignore the setting.
// Output is trimmed unless raw is set (porcelain status lines may start with a space).
export function git(root, args, { raw = false } = {}) {
  const literal = args[0] === 'check-ignore' ? [] : ['--literal-pathspecs'];
  const result = spawnSync('git', [...literal, '-c', 'core.longpaths=true', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim().slice(0, 500)}`);
  return raw ? result.stdout : result.stdout.trim();
}
// The live source must be the root of a git repository on a branch with a commit identity.
// A story starts only from a clean tree; integration fast-forwards, and git refuses that
// rather than overwrite uncommitted edits, so it leaves other local edits alone.
export function repositoryState(root, action = 'integrating source', { clean = true } = {}) {
  let top;
  try {
    top = git(root, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(`The live source must be a git repository before ${action}.`);
  }
  if (!samePath(top, root)) throw new Error('The live source must be the root of its git repository.');
  let branch;
  try {
    branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
  } catch {
    throw new Error(`Check out a branch before ${action}; HEAD is detached.`);
  }
  if (clean && git(root, ['status', '--porcelain', '--untracked-files=no']))
    throw new Error(`Commit or stash tracked changes in the live source before ${action}.`);
  const configured = key => {
    try {
      return git(root, ['config', key]);
    } catch {
      return '';
    }
  };
  if (!configured('user.name') || !configured('user.email'))
    throw new Error(`Configure git user.name and user.email before ${action}.`);
  return { branch, head: git(root, ['rev-parse', 'HEAD']) };
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
  git(root, ['commit', '--file', file, '--', ...files]);
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
function stopProcess(child) {
  try {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {}
}
export function stopIntegrationProcess(runtime) {
  const child = runtime.integrationProcess;
  if (!child) return;
  // Shutdown is an observation, not confirmation of successful process completion.
  if (runtime.closing)
    for (const phase of runtime.integrationPhases || [])
      runtime.store.finishPhase(phase, 'interrupted', {
        ...phase.evidence?.(),
        timing: 'shutdown-requested',
        completionConfirmed: false,
      });
  // Same trusted test seam the orchestrator uses for single-process fixtures inside a sandbox.
  if (runtime.fixtureProcessTermination) runtime.fixtureProcessTermination({ child }, true);
  else stopProcess(child);
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
function run(runtime, executable, args, { cwd, environment, timeoutMs, phase }) {
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
    let stdout = '',
      stderr = '',
      timedOut = false,
      observedExit = null,
      observedSignal = null;
    if (phase)
      phase.evidence = () => ({
        ...(phase.payload.phaseId === 'integration.verification' ? testPhaseEvidence(stdout) : {}),
        timedOut,
        exitCode: observedExit,
        signal: observedSignal,
      });
    child.stdout.on('data', chunk => {
      if (stdout.length < logLimit) stdout += chunk;
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
      resolve({ exitCode, signal, timedOut, stdout, stderr });
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
// Whether a commit has reached the development copy's checked-out branch.
export function landed(root, commit) {
  try {
    git(root, ['merge-base', '--is-ancestor', commit, 'HEAD']);
    return true;
  } catch {
    return false;
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
        throw new Error(
          conflicts.length
            ? `The candidate conflicts with changes integrated since its base, in ${conflicts.join(', ')}. Request a fresh candidate on the current source.`
            : `The candidate could not be merged onto the current source. ${error.message}`,
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
    return await observeIntegrationPhase(runtime, journal, 'integration.verification', async phase => {
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
      const test = runtime.sourceCheckCommand || candidateTestCommand(runtime.codexBinary, plan, configuration);
      // Same command-local test profile and copied-harness marker as candidate tests.
      environment.STUDIO_MODEL_FREE_LEAF_FIXTURES = '1';
      const tested = await run(runtime, test.executable, test.args, {
        cwd: worktree,
        environment,
        timeoutMs: testTimeoutMs,
        phase,
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
    });
  } catch (error) {
    return { passed: false, error: error.message, ...error.verification };
  }
}
