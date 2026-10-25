// Per-attempt git worktrees for source candidates (MP-016). A candidate is built from the
// commit its story started from, in a disposable worktree at a short path, and committed
// there; the development copy's working tree is never written by an attempt.
import fs from 'node:fs';
import path from 'node:path';
import { copySource, ensureSourceDirectories, sourcePlan } from './source-checks.mjs';
import { git, repositoryState, stageFiles } from './source-integration.mjs';
import { studioDeskProfile, snapshotPaths } from './source-profile.mjs';

// The commit a source story starts from. Integration still compares the live tree with the
// candidate's base, so the snapshot paths must match that commit exactly: uncommitted,
// untracked or ignored files there would never reach a candidate.
export function sourceBase(root, profile = studioDeskProfile) {
  const { branch, head } = repositoryState(root, 'a source story starts');
  const extra = git(root, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--ignored=matching',
    '--',
    ...snapshotPaths(profile),
  ])
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(3));
  if (extra.length)
    throw new Error(
      `Commit, move or delete files that git does not track before a source story starts: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ` and ${extra.length - 5} more` : ''}.`,
    );
  return { commit: head, branch };
}

// The commit intake's source checks measure (MP-016 slice 4): the tip of the development copy,
// whatever its working tree holds, so checks need no clean tree and hold no source lock.
export function sourceHead(root) {
  const { branch, head } = repositoryState(root, 'measuring the source', { clean: false });
  return { commit: head, branch };
}

// The listed files whose working-tree contents are committed on the development copy's checked-out
// branch: tracked, with nothing staged or edited since HEAD (MP-021). None when the source is not
// the root of a git repository on a branch.
export function committedPaths(root, files) {
  if (!files.length) return [];
  try {
    if (git(root, ['rev-parse', '--show-prefix'])) return [];
    git(root, ['symbolic-ref', '--quiet', 'HEAD']);
    const list = args => git(root, [...args, '--', ...files], { raw: true }).split('\0'),
      tracked = list(['ls-files', '-z']),
      edited = list(['diff', '-z', '--name-only', 'HEAD']);
    return files.filter(file => tracked.includes(file) && !edited.includes(file));
  } catch {
    return [];
  }
}

// Worktrees sit at a short path (default <data>/wt) so deep test paths stay under Windows limits.
export const sourceWorktreeRoot = runtime => runtime.sourceWorktreeRoot || path.join(runtime.store.directory, 'wt');
export const worktreeName = attemptId => attemptId.replace(/^attempt-/, '').slice(0, 8);

// Measures a commit's snapshot in its own worktree, copies it to destination and removes the
// worktree again, so a fast-forward of the development copy cannot change what is copied. The
// plan keeps the development copy as its root, the source target stories are checked against.
export function snapshotCommit(root, parent, name, base, destination, profile = studioDeskProfile) {
  const worktree = createSourceWorktree(root, parent, name, base.commit, profile);
  try {
    const plan = sourcePlan(worktree, profile);
    copySource(plan, destination);
    return { ...plan, root: fs.realpathSync(root), base };
  } finally {
    removeSourceWorktree(root, worktree);
  }
}

export function createSourceWorktree(root, parent, name, commit, profile = studioDeskProfile) {
  const target = path.join(parent, name);
  if (fs.existsSync(target)) throw new Error('A source worktree already exists for this attempt.');
  fs.mkdirSync(parent, { recursive: true });
  git(root, ['worktree', 'add', '--detach', target, commit]);
  ensureSourceDirectories(target, profile);
  return fs.realpathSync(target);
}

// New source paths that git ignores, which a candidate could not commit.
export function ignoredPaths(root, files) {
  if (!files.length) return [];
  try {
    return git(root, ['check-ignore', '--', ...files])
      .split('\n')
      .filter(Boolean);
  } catch {
    return []; // check-ignore exits 1 when no path is ignored
  }
}

// Commits the applied edits on the worktree's detached HEAD and keeps the commit reachable
// under refs/studio/candidates/, so the exact candidate survives the worktree's removal.
export function commitCandidate(worktree, files, attemptId, title) {
  stageFiles(worktree, files);
  git(worktree, [
    'commit',
    '--quiet',
    '-m',
    `Candidate: ${title}`,
    '-m',
    `Studio-Candidate: ${attemptId}`,
    '--',
    ...files,
  ]);
  const commit = git(worktree, ['rev-parse', 'HEAD']);
  git(worktree, ['update-ref', `refs/studio/candidates/${attemptId}`, commit]);
  return commit;
}

export function removeSourceWorktree(root, target) {
  try {
    git(root, ['worktree', 'remove', '--force', target]);
  } catch {
    fs.rmSync(target, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
  }
}

// The repository a worktree belongs to, from the gitdir line of its .git file
// (<repository>/.git/worktrees/<name>); null when the folder is not a linked worktree.
export function worktreeRepository(worktree) {
  try {
    const line = fs.readFileSync(path.join(worktree, '.git'), 'utf8').trim(),
      match = /^gitdir: (.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(line);
    return match ? fs.realpathSync(match[1]) : null;
  } catch {
    return null;
  }
}

// Removes worktrees left by attempts and integrations that have settled, each through the
// repository it belongs to (projects may work on different repositories). Worktrees of live,
// quarantined or unreconciled interrupted attempts, and of integrations that have not settled,
// stay for inspection until they are reconciled.
export function cleanSourceWorktrees(runtime, parent) {
  if (!fs.existsSync(parent)) return;
  const kept = new Set();
  for (const attempt of runtime.store.allAttempts()) {
    if (
      attempt.sourceWorktree &&
      (runtime.active.has(attempt.id) ||
        attempt.status === 'quarantined' ||
        (attempt.status === 'interrupted' && !attempt.reconciledAt))
    )
      kept.add(path.basename(attempt.sourceWorktree.path));
    const journal = attempt.sourceIntegration;
    if (journal?.worktree && ['verifying', 'committing', 'needs-reconciliation'].includes(journal.state))
      kept.add(path.basename(journal.worktree));
  }
  const repositories = new Set([runtime.sourceChangeRoot]);
  for (const name of fs.readdirSync(parent)) {
    if (kept.has(name)) continue;
    const target = path.join(parent, name),
      repository = worktreeRepository(target) || runtime.sourceChangeRoot;
    repositories.add(repository);
    removeSourceWorktree(repository, target);
  }
  for (const repository of repositories) git(repository, ['worktree', 'prune']);
}
