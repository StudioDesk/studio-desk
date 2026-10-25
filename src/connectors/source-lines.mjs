// Release lines (1.1 step 1, Decision MP-028). A line is a branch of a project's repository that its ideas' stories
// start from and integrate onto: `main` for the next release, and a branch such as `release/1.0` for fixes to an older
// one. Git keeps every branch, so the controller keeps no copy of its own. The branch the project's folder has checked
// out is measured from that folder, as before, so uncommitted edits there still stop a story, and integration
// fast-forwards it there. Any other branch is measured at its tip commit in a worktree git builds for the measurement
// and the controller removes at once, and integration moves it with git's own compare-and-swap, only while nothing has
// it checked out.
//
// Lines are opt-in. A project with no recorded lines keeps one, whatever its folder has checked out, exactly as in 1.0:
// every function here takes `undefined` for that line.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourcePlan } from './source-checks.mjs';
import {
  committedPaths,
  createSourceWorktree,
  ignoredPaths,
  removeSourceWorktree,
  sourceBase,
  sourceHead,
} from './source-worktrees.mjs';
import { fastForward, git, landed, repositoryState } from './source-integration.mjs';
import { projectSource } from './source-projects.mjs';
import { projectCatalog } from '../core/project-organization.mjs';
import { recordProject } from '../core/projects.mjs';

const realpath = value => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return fs.realpathSync(value);
  }
};
const samePath = (a, b) =>
  process.platform === 'win32' ? realpath(a).toLowerCase() === realpath(b).toLowerCase() : realpath(a) === realpath(b);

// The branch a folder has checked out, or null when its HEAD is detached.
export function checkedOut(root) {
  try {
    return git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null;
  } catch {
    return null;
  }
}
// The commit a branch points at.
export function branchCommit(root, branch) {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  } catch {
    throw new Error(`The branch ${branch} no longer exists in the repository.`);
  }
}
// Another worktree of the repository that has the branch checked out, or null.
export function checkedOutElsewhere(root, branch) {
  const blocks = git(root, ['worktree', 'list', '--porcelain'], { raw: true }).split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/),
      where = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length);
    if (where && lines.includes(`branch refs/heads/${branch}`) && fs.existsSync(where) && !samePath(where, root))
      return where;
  }
  return null;
}
const live = (root, line) => line === undefined || checkedOut(root) === line;

// The commit a project's source checks measure: the tip of the checked-out branch, whatever the folder holds, or of
// the line's branch.
export function lineHead(root, line) {
  if (live(root, line)) return sourceHead(root);
  repositoryState(root, 'measuring the source', { clean: false, attached: false });
  return { commit: branchCommit(root, line), branch: line };
}
// The commit a story starts from. The checked-out branch must hold nothing uncommitted in the snapshot, since
// integration fast-forwards that folder; another branch is only a commit.
export function lineBase(root, line, profile) {
  if (live(root, line)) return sourceBase(root, profile);
  repositoryState(root, 'a source story starts', { clean: false, attached: false });
  return { commit: branchCommit(root, line), branch: line };
}

// A commit never changes, so its measurement is kept for the next story or readiness check that asks.
const measured = new Map(),
  measuredLimit = 32;
let measurements = 0;
const remember = (cache, key, value) => {
  cache.set(key, value);
  if (cache.size > measuredLimit) cache.delete(cache.keys().next().value);
  return value;
};
// Runs fn in a worktree of the commit, in parent, and removes the worktree again.
function inCommit(root, commit, parent, profile, fn) {
  const worktree = createSourceWorktree(
    root,
    parent,
    `m-${commit.slice(0, 8)}-${process.pid}-${++measurements}`,
    commit,
    profile,
  );
  try {
    return fn(worktree);
  } finally {
    removeSourceWorktree(root, worktree);
  }
}
// What a story's files are measured against: the checked-out folder, or the line's tip commit as git checks it out.
// The plan keeps the repository as its root, as a snapshot's does.
export function measureLine(root, line, profile, parent) {
  if (live(root, line)) return sourcePlan(root, profile);
  const commit = branchCommit(root, line),
    key = JSON.stringify([realpath(root), commit, profile]);
  const plan =
    measured.get(key) ||
    remember(
      measured,
      key,
      inCommit(root, commit, parent, profile, worktree => ({
        ...sourcePlan(worktree, profile),
        root: fs.realpathSync(root),
      })),
    );
  return structuredClone(plan);
}

const ignoredAt = new Map();
// Reads a file at a commit as a checkout would write it (with its end-of-line and other filters).
function readAt(root, commit, file) {
  const result = spawnSync('git', ['-c', 'core.longpaths=true', 'cat-file', '--filters', `${commit}:${file}`], {
    cwd: root,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`${file} could not be read from ${commit.slice(0, 7)}.`);
  return result.stdout;
}
// How a story's scope reads the line it measured: a file's bytes, which changed files are committed, and which new
// paths git ignores. On the checked-out branch these are the folder's; on another line, its tip commit's, where every
// file is committed and the commit's own ignore rules apply.
export function lineFiles(root, line, profile, parent) {
  if (live(root, line))
    return {
      read: file => fs.readFileSync(path.join(root, file)),
      committed: files => committedPaths(root, files),
      ignored: files => ignoredPaths(root, files),
    };
  const commit = branchCommit(root, line);
  return {
    read: file => readAt(root, commit, file),
    committed: files => [...files],
    ignored: files => {
      if (!files.length) return [];
      const key = JSON.stringify([realpath(root), commit, [...files].sort()]);
      return [
        ...(ignoredAt.get(key) ||
          remember(
            ignoredAt,
            key,
            inCommit(root, commit, parent, profile, worktree => ignoredPaths(worktree, files)),
          )),
      ];
    },
  };
}

// What an integration records about where it lands: the checked-out branch and its tip, as before, or the line's
// branch and tip with `live: false`.
export function lineRepository(root, line) {
  if (live(root, line)) return repositoryState(root, 'integrating source', { clean: false });
  repositoryState(root, 'integrating source', { clean: false, attached: false });
  return { branch: line, head: branchCommit(root, line), live: false };
}
// Moves the line to the verified integration commit. The checked-out branch is fast-forwarded in its folder; another
// branch moves only if it still points at the commit verification merged onto and nothing has it checked out, since
// moving a branch under a working tree would leave that tree behind it.
export function moveLine(root, journal) {
  const { branch, head } = journal.repository;
  if (journal.repository.live !== false) return fastForward(root, journal);
  if (checkedOut(root) === branch)
    throw new Error(
      `${branch} was checked out in the project's folder during verification. Approve integration again to merge onto it there.`,
    );
  const elsewhere = checkedOutElsewhere(root, branch);
  if (elsewhere)
    throw new Error(
      `${branch} is checked out in ${elsewhere}. Studio desk moves a branch only in the project's folder or where nothing has it checked out: check out another branch there, then approve integration again.`,
    );
  try {
    git(root, ['update-ref', '-m', 'Studio desk integration', `refs/heads/${branch}`, journal.commit, head]);
  } catch {
    throw new Error(`${branch} moved during verification. Approve integration again to merge onto the current tip.`);
  }
}
// Whether an integration's commit has reached its line.
export const lineReached = (root, journal) =>
  journal.repository?.live === false
    ? landed(root, journal.commit, `refs/heads/${journal.repository.branch}`)
    : landed(root, journal.commit);

// A project's lines, oldest first; the last is its newest line, where the next release is made. None are recorded
// until a second line is added.
export const projectLines = project => project.lines || [];
const newest = project => projectLines(project).at(-1);
// The line a story or idea works on: undefined for a project with no recorded lines (whatever its folder has checked
// out), otherwise the branch recorded with its measured checks, or the newest line.
export function projectLine(store, projectId, branch) {
  const project = store.project(projectId);
  if (!projectLines(project).length) return undefined;
  return branch || newest(project).branch;
}
// The measured checks a story's scope rests on: pinned directly by a breakdown story, or behind the source review a
// review's story pins.
function storyChecks(store, task) {
  const attempt = id => {
    try {
      return store.attempt(id);
    } catch {
      return null;
    }
  };
  for (const input of task.acceptedInputs || []) {
    const pinned = attempt(input.attemptId);
    if (pinned?.sourceCheck) return pinned;
    if (pinned?.sourceReview?.attemptId) return attempt(pinned.sourceReview.attemptId);
  }
  return null;
}
// The line a source story works on (see projectLine).
export const storyLine = (store, task) =>
  projectLine(store, recordProject(task), storyChecks(store, task)?.sourceCheck?.base?.branch);

// A branch name git accepts as written. check-ref-format --branch would also expand @{-1} to the branch checked out
// before, which is not a name.
const branchName = (root, branch) => {
  if (typeof branch !== 'string' || !branch || branch.length > 100 || branch.startsWith('-'))
    throw new Error('Name the line with a branch name of at most 100 characters.');
  if (branch.includes('@{')) throw new Error(`${branch} is not a name git allows for a branch.`);
  try {
    return git(root, ['check-ref-format', '--branch', branch]);
  } catch {
    throw new Error(`${branch} is not a name git allows for a branch.`);
  }
};
const sourceRoot = (store, projectId, runtime) => {
  if (!projectCatalog(store, runtime.registries, projectId).some(item => item.kind === 'studio-development:change'))
    throw new Error('Only a project on the source workflow keeps release lines.');
  return projectSource(store, projectId, runtime).root;
};
// Adds a line for an existing branch, or for a new branch made at `from` (a tag, branch or commit). The first line
// added also records the branch the folder has checked out as the newest line; later lines go before the newest one,
// in the order they were made.
export function addProjectLine(store, projectId, runtime, { branch, from } = {}) {
  const root = sourceRoot(store, projectId, runtime);
  branch = branchName(root, branch);
  const project = store.project(projectId),
    at = new Date().toISOString();
  let lines = projectLines(project);
  if (!lines.length) {
    const current = checkedOut(root);
    if (!current) throw new Error('Check out the branch new releases are made on before adding a line.');
    lines = [{ branch: current, state: 'maintained', at }];
  }
  if (lines.some(line => line.branch === branch)) throw new Error(`${branch} is already a line of this project.`);
  let commit;
  if (from !== undefined) {
    if (typeof from !== 'string' || !from || from.length > 200 || from.startsWith('-'))
      throw new Error('Start the line from a tag, branch or commit.');
    try {
      commit = git(root, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`]);
    } catch {
      throw new Error(`The repository has no tag, branch or commit named ${from}.`);
    }
    let exists = true;
    try {
      branchCommit(root, branch);
    } catch {
      exists = false;
    }
    if (exists) throw new Error(`A branch named ${branch} already exists. Add it as a line without a starting point.`);
    git(root, ['branch', '--no-track', branch, commit]);
  } else
    try {
      commit = branchCommit(root, branch);
    } catch {
      throw new Error(`The repository has no branch named ${branch}. Give a tag, branch or commit to start it from.`);
    }
  project.lines = [
    ...lines.slice(0, -1),
    { branch, state: 'maintained', at, ...(from !== undefined ? { from } : {}) },
    lines.at(-1),
  ];
  store.putProject(project);
  store.event(
    'project_line',
    null,
    null,
    `Line ${branch} added${from !== undefined ? ` from ${from}` : ''} at ${commit.slice(0, 7)}; ideas can now land on it.`,
    projectId,
  );
  return project.lines;
}
// Retires a line, so no new idea lands on it, or keeps it again. Work already on it finishes. The newest line cannot
// be retired.
export function retireProjectLine(store, projectId, { branch, retired } = {}) {
  const project = store.project(projectId),
    lines = projectLines(project),
    line = lines.find(item => item.branch === branch);
  if (!line) throw new Error(`${branch} is not a line of this project.`);
  if (typeof retired !== 'boolean') throw new Error('Say whether the line is retired.');
  if (retired && line === lines.at(-1))
    throw new Error('The newest line takes the next release; it cannot be retired.');
  if ((line.state === 'retired') === retired) return lines;
  line.state = retired ? 'retired' : 'maintained';
  store.putProject(project);
  store.event(
    'project_line',
    null,
    null,
    retired ? `Line ${branch} retired; no new idea lands on it.` : `Line ${branch} is maintained again.`,
    projectId,
  );
  return lines;
}
// The line a new idea lands on: the one asked for, which must be a maintained line, or the newest line. Undefined for
// a project with no recorded lines, which takes an idea on whatever its folder has checked out.
export function ideaLine(store, projectId, runtime, requested) {
  const project = store.project(projectId),
    lines = projectLines(project);
  if (requested === undefined) return lines.length ? newest(project).branch : undefined;
  if (!lines.length) {
    if (typeof requested === 'string' && requested === checkedOut(sourceRoot(store, projectId, runtime)))
      return undefined;
    throw new Error('This project keeps one line. Add a line before sending an idea to another branch.');
  }
  const line = lines.find(item => item.branch === requested);
  if (!line) throw new Error(`${requested} is not a line of this project.`);
  if (line.state === 'retired') throw new Error(`${requested} is retired, so no new idea lands on it.`);
  return line.branch;
}
