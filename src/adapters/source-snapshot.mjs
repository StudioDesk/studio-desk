// Trusted controller operation shared by source checks and consumers of measured source.
// This does not resolve accepted inputs or grant an employee access to source: the caller
// supplies the recorded commit and, for a verified planning copy, its accepted check report.
import fs from 'node:fs';
import path from 'node:path';
import { sourcePlan } from '../connectors/source-checks.mjs';
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
