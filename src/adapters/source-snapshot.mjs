// Trusted controller operation shared by source checks and consumers of measured source.
// This does not resolve accepted inputs or grant an employee access to source: the caller
// supplies the recorded commit and, for a verified planning copy, its accepted check report.
// An attempt makes and checks its copy in a process of its own (inSnapshotProcess), as a story's
// setup does (source-setup.mjs): git and hashing a large repository take seconds, which the
// controller would otherwise spend not answering (October 29: 7- and 19-second stalls as an
// idea's planning started). This file is also that process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourcePlan, verifyCopy } from '../connectors/source-checks.mjs';
import { snapshotCommit as copyCommit, removeSourceWorktree } from '../connectors/source-worktrees.mjs';
import { profileOf, studioDeskProfile } from '../connectors/source-profile.mjs';

// Re-measure the copy with the recorded profile's allowlist and limits. Never measure the live
// working tree to decide what the recorded commit should contain. A negative measured
// report is valid evidence too; acceptance/provenance remain the caller's responsibility.
export function verifySnapshot(plan, destination, report) {
  try {
    const copied = sourcePlan(destination, profileOf(plan));
    if (copied.sourceHash !== plan.sourceHash || JSON.stringify(copied.files) !== JSON.stringify(plan.files))
      throw new Error('The copied manifest or fingerprint differs from the measured commit.');
    if (
      report &&
      (report.schemaVersion !== 'source-check-report-v1' ||
        report.source?.root !== plan.root ||
        report.source?.commit !== plan.base?.commit ||
        report.source?.hash !== copied.sourceHash ||
        JSON.stringify(report.source?.files) !== JSON.stringify(copied.files))
    )
      throw new Error('The copied source identity, manifest or fingerprint differs from the accepted report.');
    return plan;
  } catch (error) {
    throw new Error(`Source snapshot integrity failure: ${error.message}`, { cause: error });
  }
}

// Retains snapshotCommit's plan shape, including the repository root separately from
// the short-lived worktree. No HEAD fallback: callers must select an immutable commit.
export function snapshotCommit(root, parent, name, base, destination, report, profile = studioDeskProfile) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base?.commit || ''))
    throw new Error('A recorded source commit is required for a snapshot.');
  const worktree = path.resolve(parent, name);
  if (path.dirname(worktree) !== path.resolve(parent)) throw new Error('Invalid source snapshot worktree name.');
  // Only clean paths acquired by this call; never replace another caller's copy or tree.
  if (fs.existsSync(worktree)) throw new Error('A source worktree already exists for this attempt.');
  if (fs.existsSync(destination)) throw new Error('A source snapshot destination already exists.');
  try {
    const plan = copyCommit(root, parent, name, base, destination, profile);
    return verifySnapshot(plan, destination, report);
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    // The existing operation normally removes its worktree. It can also fail while
    // preparing its allowlisted directories, before returning the worktree path.
    if (fs.existsSync(worktree)) removeSourceWorktree(root, worktree);
  }
}

const self = fileURLToPath(import.meta.url),
  operations = {
    snapshotCommit: r => snapshotCommit(r.root, r.parent, r.name, r.base, r.destination, r.report, r.profile),
    verifySnapshot: r => verifySnapshot(r.plan, r.destination, r.report),
    verifyCopy: r => verifyCopy(r.plan, r.destination) ?? null,
  };

// Runs one of the operations above as a step of the attempt, in a process of its own, so a stop and the
// attempt's time limit end it as they end every other step, then calls `next` with what it returned. A
// failed operation fails the attempt with its error, worded by `failure`. While a snapshot is made, its
// worktree is the attempt's (entry.snapshotWorktree), so a story's setup does not take it for a leftover.
// The process answers in a file in the job folder, { value } or { error }, never through the attempt's log.
export function inSnapshotProcess(runtime, entry, operation, request, next, failure = message => message) {
  const answer = path.join(entry.job, operation + '.json');
  if (operation === 'snapshotCommit') entry.snapshotWorktree = request.name;
  runtime.runNative(entry, process.execPath, [self], JSON.stringify({ operation, request, answer }), () => null, {
    cwd: entry.job,
    resultOnFailure: true,
    onComplete: (result, code) => {
      delete entry.snapshotWorktree;
      let answered = {};
      try {
        answered = JSON.parse(fs.readFileSync(answer, 'utf8'));
        fs.rmSync(answer, { force: true });
      } catch {}
      if (code !== 0 || !Object.hasOwn(answered, 'value'))
        throw new Error(failure(answered.error || 'Copying the source failed. See the attempt log.'));
      next(answered.value);
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => (input += chunk));
  process.stdin.on('end', () => {
    const { operation, request, answer } = JSON.parse(input),
      // Written anew, never through a file left in its place.
      reply = value => {
        fs.rmSync(answer, { force: true });
        fs.writeFileSync(answer, JSON.stringify(value), { flag: 'wx' });
      };
    try {
      if (!Object.hasOwn(operations, operation)) throw new Error('Unknown source operation.');
      reply({ value: operations[operation](request) });
    } catch (error) {
      console.error(error.message);
      reply({ error: error.message });
      process.exitCode = 1;
    }
  });
}
