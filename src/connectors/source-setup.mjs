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
import { createSourceWorktree, removeWorktrees } from './source-worktrees.mjs';
import { lastLine } from './package-installs.mjs';

const self = fileURLToPath(import.meta.url),
  steps = ['setup.worktree', 'setup.snapshot', 'setup.copy'];

export const snapshotMismatch = 'The base commit does not match the approved source snapshot. Start a new attempt.';

// Runs the setup process as a step of the attempt, records each step it reports as a setup phase, then calls `next`.
// A failed step stops the attempt with the step's error.
export function runSourceSetup(runtime, entry, request, next) {
  const phases = new Map();
  let pending = '',
    failure = '',
    errors = '';
  runtime.runNative(entry, process.execPath, [self], JSON.stringify(request), () => null, {
    cwd: entry.job,
    resultOnFailure: true,
    onComplete: (result, code) => {
      if (code !== 0)
        throw new Error(failure || lastLine(errors) || 'Setting up the attempt failed. See the attempt log.');
      next();
    },
  });
  entry.child.stdout.on('data', chunk => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      let progress;
      try {
        progress = JSON.parse(line);
      } catch {
        continue;
      }
      if (!steps.includes(progress?.phase)) continue;
      if (progress.boundary === 'start') phases.set(progress.phase, runtime.startPhase(entry, progress.phase));
      else if (phases.has(progress.phase) && ['succeeded', 'failed'].includes(progress.outcome)) {
        const phase = phases.get(progress.phase);
        // The phase takes the time the step measured, not the time its lines took to arrive.
        if (Number.isFinite(progress.durationMs)) phase.clock = performance.now() - Math.max(0, progress.durationMs);
        runtime.store.finishPhase(phase, progress.outcome, progress.error ? { error: progress.error } : {});
        if (progress.error) failure = String(progress.error);
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
  // The base commit holds exactly the snapshot the story's scope approved.
  step('setup.snapshot', () => {
    holdWhile(request.hold);
    try {
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
