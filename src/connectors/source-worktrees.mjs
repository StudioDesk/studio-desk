// Per-attempt git worktrees for source candidates (MP-016). A candidate is built from the
// commit its story started from, in a disposable worktree at a short path, and committed
// there; the development copy's working tree is never written by an attempt.
import fs from 'node:fs';
import { realPath } from '../core/real-path.mjs';
import path from 'node:path';
import { copySource, ensureSourceDirectories, sourcePlan } from './source-checks.mjs';
import { git, repositoryState, stageFiles } from './source-integration.mjs';
import { studioDeskProfile, snapshotPaths } from './source-profile.mjs';
import { hash } from '../core/contracts.mjs';
import { runGit } from '../git.mjs';

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
// Every file committedPaths would answer for, listed once for the whole repository: a measurement that checks many
// stories' files asks git four times in all instead of four times for each story (October 29). Empty when the source
// is not the root of a git repository on a branch.
export function committedFiles(root) {
  try {
    if (git(root, ['rev-parse', '--show-prefix'])) return new Set();
    git(root, ['symbolic-ref', '--quiet', 'HEAD']);
    const list = args => git(root, args, { raw: true }).split('\0').filter(Boolean),
      edited = new Set(list(['diff', '-z', '--name-only', 'HEAD']));
    return new Set(list(['ls-files', '-z']).filter(file => !edited.has(file)));
  } catch {
    return new Set();
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
    return { ...plan, root: realPath(root), base };
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
  // Its real spelling, which also expands a Windows short name (fs.realpathSync keeps those, and the given case).
  return realPath(target);
}

// Gives a worktree of `commit` the bytes of the folder its snapshot measured (plan.root), file by file, where git
// writes the same committed file differently. A repository that rewrites line endings (core.autocrlf=true, Git for
// Windows' default) checks a text file out with CRLF, while the director's folder may hold it with LF (written by a
// tool or an agent and committed, never checked out again): the same commit, other bytes, and the story's working copy
// would not match its approved snapshot. A file is taken from the folder only when its bytes are the ones the snapshot
// recorded and git stores them as exactly the commit's file (the same object once its own filters clean them), so the
// working copy still holds the commit. Nothing is written to the folder or its settings. Returns the paths taken.
export function matchMeasuredFolder(worktree, plan, commit) {
  const folder = plan.root,
    readFile = (root, file) => {
      const target = path.join(root, file);
      try {
        return fs.lstatSync(target).isFile() ? fs.readFileSync(target) : null;
      } catch {
        return null;
      }
    },
    differing = plan.files.filter(item => {
      if (item.path.includes('\n')) return false;
      const bytes = readFile(worktree, item.path);
      return bytes && hash(bytes) !== item.hash;
    });
  if (!differing.length || !folder || path.resolve(folder) === path.resolve(worktree)) return [];
  const measured = new Map();
  for (const item of differing) {
    const bytes = readFile(folder, item.path);
    if (bytes && hash(bytes) === item.hash) measured.set(item.path, bytes);
  }
  if (!measured.size) return [];
  const files = [...measured.keys()],
    big = { maxBuffer: 64 * 1024 * 1024 };
  let stored, committed;
  try {
    // The object each folder file would be stored as, with the repository's own filters, and the commit's objects.
    stored = runGit(folder, ['hash-object', '--stdin-paths'], { input: files.join('\n') + '\n', ...big }).split('\n');
    committed = new Map();
    const tree = runGit(worktree, ['ls-tree', '-r', '-z', '--full-tree', commit], { raw: true, ...big });
    for (const entry of tree.split('\0')) {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
      if (match) committed.set(match[2], match[1]);
    }
  } catch {
    return [];
  }
  const taken = [];
  files.forEach((file, index) => {
    const bytes = measured.get(file),
      again = readFile(folder, file);
    // Still the measured bytes after git read them, so the object git named is theirs.
    if (!stored[index] || stored[index] !== committed.get(file) || !again || hash(again) !== hash(bytes)) return;
    fs.writeFileSync(path.join(worktree, file), bytes);
    taken.push(file);
  });
  // git takes a file of another size for an edited one without reading it, so the working copy's index learns the
  // bytes: staged again, each is the object it already holds, and the copy reads as its commit. A repository that
  // refuses line endings it would not write back (core.safecrlf) is not asked here, where they are the folder's own.
  if (taken.length)
    runGit(worktree, ['-c', 'core.safecrlf=false', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: taken.join('\0') + '\0',
    });
  return taken;
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
    return match ? realPath(match[1]) : null;
  } catch {
    return null;
  }
}

// Removes worktrees left by attempts and integrations that have settled, each through the
// repository it belongs to (projects may work on different repositories). Worktrees of live,
// quarantined or unreconciled interrupted attempts, and of integrations that have not settled,
// stay for inspection until they are reconciled.
export function cleanSourceWorktrees(runtime, parent) {
  removeWorktrees(leftoverWorktrees(runtime, parent));
}

// The worktrees cleanSourceWorktrees removes, each with its repository, and the repositories to prune, read from the
// controller's records. A code story's setup removes them in its own process (source-setup.mjs).
export function leftoverWorktrees(runtime, parent) {
  if (!fs.existsSync(parent)) return { worktrees: [], repositories: [] };
  const kept = new Set(),
    store = runtime.store;
  // Read through the store's lookups, not the whole history: every code story's setup asks.
  // An idea's checks copy (sourceCheckFolder) stays under the same conditions as a candidate's worktree.
  for (const attempt of [...store.liveAttempts(), ...[...runtime.active.values()].map(entry => entry.attempt)])
    if (
      runtime.active.has(attempt.id) ||
      attempt.status === 'quarantined' ||
      (attempt.status === 'interrupted' && !attempt.reconciledAt)
    )
      for (const folder of [attempt.sourceWorktree, attempt.sourceCheckFolder])
        if (folder?.path) kept.add(path.basename(folder.path));
  // So does the worktree an idea's checks or planner measures its snapshot in, while its process makes it.
  for (const entry of runtime.active.values()) if (entry.snapshotWorktree) kept.add(entry.snapshotWorktree);
  // An integration's worktree, and a carry's (1.1 step 4), stay while they run or wait to be reconciled.
  const holding = ['verifying', 'committing', 'needs-reconciliation'];
  for (const journal of [
    ...store.integrationJournals(...holding).map(record => record.sourceIntegration),
    ...store.carryJournals().flatMap(record => record.sourceCarries),
  ])
    if (journal?.worktree && holding.includes(journal.state)) kept.add(path.basename(journal.worktree));
  // So do a release's two worktrees, its draft and its verification (1.1 step 5), recorded on its milestone.
  for (const project of runtime.store.projects())
    for (const milestone of runtime.store.setting('milestones:' + project.id) || []) {
      const release = milestone.release;
      if (release?.worktree && ['verifying', 'committing', 'needs-reconciliation'].includes(release.state))
        for (const worktree of [release.worktree, `${release.worktree}d`]) kept.add(path.basename(worktree));
    }
  const repositories = new Set([runtime.sourceChangeRoot]),
    worktrees = [];
  for (const name of fs.readdirSync(parent)) {
    if (kept.has(name)) continue;
    const target = path.join(parent, name),
      repository = worktreeRepository(target) || runtime.sourceChangeRoot;
    repositories.add(repository);
    worktrees.push({ repository, path: target, identity: folderIdentity(target) });
  }
  return { worktrees, repositories: [...repositories] };
}

// Removes the listed worktrees and prunes their repositories. A folder made again under a listed name since it was
// listed, as a retried integration of the same review makes its i- worktree, is no longer the one listed and stays.
export function removeWorktrees({ worktrees, repositories }) {
  for (const worktree of worktrees)
    if (!worktree.identity || folderIdentity(worktree.path) === worktree.identity)
      removeSourceWorktree(worktree.repository, worktree.path);
  for (const repository of repositories) git(repository, ['worktree', 'prune']);
}

// What tells a folder from another made later at the same path: its file number, birth and change times.
function folderIdentity(target) {
  try {
    const stat = fs.lstatSync(target, { bigint: true });
    return `${stat.ino}:${stat.birthtimeNs}:${stat.ctimeNs}`;
  } catch {
    return null;
  }
}
