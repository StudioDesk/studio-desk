// A code story's setup in a process of its own, as package installs run (package-installs.mjs): the attempt's
// working copy of the repository at the story's base commit, its check against the approved snapshot, the read-only
// source the editor reads and the approved files it edits under changes/. git and the copies take seconds on a large
// repository, which the controller would otherwise spend not answering. The controller sends the request on stdin;
// the process prints a line as each step starts and finishes, which the controller records as the attempt's setup
// phases with the time each step measured. This file is also that process, so a stop and the time limit end it as
// they end every other step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copySource, verifyCopy } from './source-checks.mjs';
import { createSourceWorktree, matchMeasuredFolder, removeWorktrees } from './source-worktrees.mjs';
import { lastLine } from './package-installs.mjs';

const self = fileURLToPath(import.meta.url),
  steps = ['setup.worktree', 'setup.snapshot', 'setup.copy'];

export const snapshotMismatch = 'The base commit does not match the approved source snapshot. Start a new attempt.';

// What each setup step is doing, in the words a setup that ended without a reason uses.
const stepWords = {
  'setup.worktree': 'making the working copy',
  'setup.snapshot': 'checking the snapshot',
  'setup.copy': 'copying the source',
};

// How a setup process that reported no failed step and wrote no error line ended, so it was stopped or crashed from
// outside without a word: the exit code (with its hexadecimal form when it is a large Windows status, such as
// 0xC0000142) or the signal that ended it, the step that had started and not finished (`step`), else the last step
// that finished (`finished`), else that no step was reported, and the last line it wrote (`output`).
export function setupEndedMessage({ code = null, signal = null, step = '', finished = '', output = '' } = {}) {
  const status = Number.isInteger(code) && Math.abs(code) > 0xffff ? ` (0x${hex(code)})` : '',
    how = signal
      ? `was stopped by the signal ${signal}`
      : Number.isInteger(code)
        ? `ended with exit code ${code}${status}`
        : 'ended without an exit code',
    when = step
      ? `while ${stepWords[step] || step}`
      : finished
        ? `after ${stepWords[finished] || finished}`
        : 'before reporting any step',
    last = String(output || '').trim();
  return `Setting up the attempt failed: the setup process ${how} ${when}.${last ? ` Its last output line was: ${last}` : ''}`;
}

// A 32-bit exit status in hexadecimal, as Windows names its statuses (3221225794 is C0000142).
const hex = code => (code >>> 0).toString(16).toUpperCase().padStart(8, '0');

// Runs the setup process as a step of the attempt, records each step it reports as a setup phase, then calls `next`.
// A failed step stops the attempt with the step's error, else the last line the process wrote to stderr, else how the
// process ended (setupEndedMessage).
export function runSourceSetup(runtime, entry, request, next) {
  const phases = new Map();
  let pending = '',
    failure = '',
    errors = '',
    // The step that has started and not finished, the last step that finished and the last line on stdout.
    open = '',
    finished = '',
    output = '';
  runtime.runNative(entry, process.execPath, [self], JSON.stringify(request), () => null, {
    cwd: entry.job,
    resultOnFailure: true,
    onComplete: (result, code, signal) => {
      if (code !== 0)
        throw new Error(
          failure ||
            lastLine(errors) ||
            setupEndedMessage({ code, signal, step: open, finished, output: pending.trim() || output }),
        );
      next();
    },
  });
  entry.child.stdout.on('data', chunk => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (line.trim()) output = line.trim();
      let progress;
      try {
        progress = JSON.parse(line);
      } catch {
        continue;
      }
      if (!steps.includes(progress?.phase)) continue;
      if (progress.boundary === 'start') {
        phases.set(progress.phase, runtime.startPhase(entry, progress.phase));
        open = progress.phase;
      } else if (phases.has(progress.phase) && ['succeeded', 'failed'].includes(progress.outcome)) {
        const phase = phases.get(progress.phase);
        // The phase takes the time the step measured, not the time its lines took to arrive.
        if (Number.isFinite(progress.durationMs)) phase.clock = performance.now() - Math.max(0, progress.durationMs);
        runtime.store.finishPhase(phase, progress.outcome, progress.error ? { error: progress.error } : {});
        if (progress.error) failure = String(progress.error);
        if (open === progress.phase) open = '';
        finished = progress.phase;
      }
    }
  });
  entry.child.stderr.on('data', text => (errors += text));
}

// The setup's steps in order, each reported as it starts and finishes with its measured time. A failing step reports
// its error and ends the setup.
export function prepareSource(request, report) {
  const step = (phase, work) => {
    report({ phase, boundary: 'start' });
    const started = performance.now();
    try {
      work();
    } catch (error) {
      report({
        phase,
        boundary: 'finish',
        outcome: 'failed',
        durationMs: performance.now() - started,
        error: error.message,
      });
      throw error;
    }
    report({ phase, boundary: 'finish', outcome: 'succeeded', durationMs: performance.now() - started });
  };
  let worktree;
  step('setup.worktree', () => {
    // Worktrees the controller found left by settled attempts and integrations go first.
    if (request.leftovers) removeWorktrees(request.leftovers);
    worktree = createSourceWorktree(request.repository, request.parent, request.name, request.commit, request.profile);
  });
  // The base commit holds exactly the snapshot the story's scope approved. A file git checked out with other line
  // endings than the measured folder holds it, the same committed file, takes the folder's bytes first
  // (matchMeasuredFolder), so the working copy and its snapshot agree byte for byte whatever git's settings are.
  step('setup.snapshot', () => {
    holdWhile(request.hold);
    try {
      matchMeasuredFolder(worktree, request.snapshot, request.commit);
      verifyCopy(request.snapshot, worktree);
    } catch {
      throw new Error(snapshotMismatch);
    }
  });
  step('setup.copy', () => {
    // The read-only context copy the employee reads at ../source, from that commit: the story's line
    // may be a branch the project's folder does not have checked out (1.1 step 1).
    copySource({ ...request.snapshot, root: worktree }, request.source);
    for (const file of request.allowedFiles) {
      const destination = path.join(request.changes, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(request.source, file), destination);
    }
    // New files are written at changes/<path>; files listed for deletion are not staged.
    for (const file of request.newFiles)
      fs.mkdirSync(path.dirname(path.join(request.changes, file)), { recursive: true });
  });
}

// A trusted model-free test seam, never exposed by HTTP (the runner's sourceSetupHold): a test holds the setup here,
// with the working copy made and its snapshot phase open, until it removes the file named.
function holdWhile(file) {
  while (file && fs.existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  let request = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => (request += chunk));
  process.stdin.on('end', () => {
    try {
      // Each line is written at once, so the controller sees a step start while the step still runs.
      prepareSource(JSON.parse(request), progress => fs.writeSync(1, JSON.stringify(progress) + '\n'));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });
}
