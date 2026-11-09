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
import { runGit } from '../git.mjs';
import { sourcePlan } from './source-checks.mjs';
import {
  committedFiles,
  createSourceWorktree,
  ignoredPaths,
  removeSourceWorktree,
  sourceBase,
  sourceHead,
} from './source-worktrees.mjs';
import { fastForward, git, gitAsync, landed, repositoryState } from './source-integration.mjs';
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
// The same two answers without holding the controller's thread (C-20).
export const checkedOutAsync = root =>
  gitAsync(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(
    branch => branch || null,
    () => null,
  );
export const branchCommitAsync = (root, branch) =>
  gitAsync(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).catch(() => {
    throw new Error(`The branch ${branch} no longer exists in the repository.`);
  });
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
  try {
    return runGit(root, ['cat-file', '--filters', `${commit}:${file}`], {
      encoding: null,
      literal: false,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${file} could not be read from ${commit.slice(0, 7)}.`);
  }
}
// How a story's scope reads the line it measured: a file's bytes, which changed files are committed, which missing
// files a commit deleted, and which new paths git ignores. On the checked-out branch these are the folder's; on another line, its tip commit's, where every
// file is committed and the commit's own ignore rules apply.
export function lineFiles(root, line, profile, parent) {
  if (live(root, line)) {
    // Which files are committed, and which HEAD holds, are listed once for the whole repository when first asked and
    // kept with this measurement, which a scheduler pass checks every waiting story against (October 29: asking git
    // for each story held the controller for seconds once a slot came free).
    let committed, inHead;
    return {
      read: file => fs.readFileSync(path.join(root, file)),
      committed: files => (files.length ? files.filter(file => (committed ||= committedFiles(root)).has(file)) : []),
      ignored: files => ignoredPaths(root, files),
      gone: files => {
        if (!files.length) return [];
        inHead ||= new Set(git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { raw: true }).split('\0'));
        return files.filter(file => !inHead.has(file));
      },
    };
  }
  const commit = branchCommit(root, line);
  return {
    read: file => readAt(root, commit, file),
    committed: files => [...files],
    gone: files => [...files],
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

// A measurement's failure as the measuring process sends it, and the error a check then throws again: its message and
// the fields a refusal is read by.
const failure = error => ({
  message: String(error?.message ?? error),
  ...(error?.code !== undefined ? { code: error.code } : {}),
  ...(error?.outdated ? { outdated: structuredClone(error.outdated) } : {}),
});
export const measuredError = ({ message, ...fields }) => Object.assign(new Error(message), fields);
const answer = fn => {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: failure(error) };
  }
};
// The measurements this controller keeps of commits (measureLine, lineFiles), so the measuring process leaves out what
// is already known.
export const knownMeasurements = () => [...measured.keys(), ...ignoredAt.keys()];
// What the checked-out folder holds beyond its commit: git's status of every changed, staged and untracked file
// (ignored files left out, and without the index lock git would otherwise take to refresh it), with the content hash of
// each file status lists, so a second edit to a file already changed counts too. It hashes only those files.
function worktreeState(root) {
  const status = runGit(root, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all'], {
      raw: true,
    }),
    entries = status.split('\0'),
    listed = [];
  // Porcelain v2: `1 XY sub mH mI mW hH hI path`, `2 ... X score path` followed by the original path, `u ... path`,
  // and `? path` for an untracked file.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i],
      fields = { 1: 8, 2: 9, u: 10 }[entry[0]];
    if (entry.startsWith('? ')) listed.push(entry.slice(2));
    else if (fields) listed.push(entry.split(' ').slice(fields).join(' '));
    if (entry[0] === '2') i++;
  }
  const files = [],
    other = [];
  for (const file of listed) {
    let stat;
    try {
      stat = fs.lstatSync(path.join(root, file));
    } catch {
      continue; // Deleted: status names it.
    }
    // git reads one path a line; a name holding a line break is told apart by its size and time instead.
    if (stat.isFile() && !/[\r\n]/.test(file)) files.push(file);
    else other.push([file, stat.isFile() ? stat.size : null, stat.mtimeMs]);
  }
  const hashes = files.length
    ? runGit(root, ['hash-object', '--stdin-paths'], { input: files.join('\n') + '\n' }).split(/\r?\n/)
    : [];
  return { status, hashes: files.map((file, i) => [file, hashes[i]]), other };
}
// Where a line stands: the commit the folder has checked out and, for a named line, the branch checked out and the
// line's tip; for the line checked out, also its uncommitted state (worktreeState). The measuring process records it
// before it measures, and a pass reuses that measurement only while the line still stands there (an integration, a
// director's commit, or an edit or new file in the checked-out folder since moves it), asking git and hashing only the
// files status lists.
export function lineTip(root, line) {
  return JSON.stringify([
    answer(() => git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])),
    ...(line === undefined ? [] : [answer(() => checkedOut(root)), answer(() => branchCommit(root, line))]),
    ...(live(root, line) ? [answer(() => worktreeState(root))] : []),
  ]);
}
// What a story's scope check asks of a line, measured at once, as the measuring process does for a dispatch pass
// (src/connectors/source-measure.mjs): the line's plan (measureLine), the commit a story would start from (lineBase),
// which files are committed and which HEAD holds, and which of each list of new files git ignores (lineFiles). Each
// answer is a value or the failure measuring on the thread would have thrown. A commit's plan or ignore answer in
// `known` is left out and named by its key.
export function lineMeasurement(root, line, profile, parent, { ignored = [], known = [] } = {}) {
  const tip = lineTip(root, line),
    lists = ignored.filter(files => files.length),
    base = answer(() => lineBase(root, line, profile));
  if (live(root, line))
    return {
      tip,
      live: true,
      plan: answer(() => sourcePlan(root, profile)),
      base,
      committed: [...committedFiles(root)],
      inHead: answer(() => git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { raw: true }).split('\0')),
      ignored: lists.map(files => [JSON.stringify(files), { value: ignoredPaths(root, files) }]),
    };
  let commit;
  try {
    commit = branchCommit(root, line);
  } catch (error) {
    return { tip, live: false, plan: { error: failure(error) }, base };
  }
  const real = realpath(root),
    planKey = JSON.stringify([real, commit, profile]),
    listKey = files => JSON.stringify([real, commit, [...files].sort()]),
    plan = known.includes(planKey) ? null : {},
    asked = lists.filter(files => !known.includes(listKey(files))),
    answers = new Map();
  if (plan || asked.length) {
    const measuredHere = answer(() =>
      inCommit(root, commit, parent, profile, worktree => {
        if (plan)
          Object.assign(
            plan,
            answer(() => ({ ...sourcePlan(worktree, profile), root: fs.realpathSync(root) })),
          );
        for (const files of asked)
          answers.set(
            JSON.stringify(files),
            answer(() => ignoredPaths(worktree, files)),
          );
      }),
    );
    // A working copy that could not be made or removed fails each answer it was for, as it fails each on the thread.
    if (measuredHere.error) {
      if (plan) Object.assign(plan, { error: measuredHere.error });
      for (const files of asked) answers.set(JSON.stringify(files), { error: measuredHere.error });
    }
  }
  return {
    tip,
    live: false,
    commit,
    real,
    plan: { key: planKey, ...(plan || {}) },
    base,
    ignored: lists.map(files => [
      JSON.stringify(files),
      { key: listKey(files), ...(answers.get(JSON.stringify(files)) || {}) },
    ]),
  };
}
// The plan and file answers a check reads from a line measured by the measuring process (lineMeasurement), as
// measureLine and lineFiles would answer: a failure is thrown again with its message, a commit's measurement is kept as
// the thread keeps its own, and a list the process was not asked about is answered on the thread.
export function measuredLine(root, line, profile, parent, measurement) {
  const asked = new Map(measurement.ignored || []);
  if (measurement.plan.error) throw measuredError(measurement.plan.error);
  if (measurement.live) {
    const committed = new Set(measurement.committed),
      inHead = measurement.inHead.value && new Set(measurement.inHead.value);
    return {
      current: measurement.plan.value,
      files: {
        read: file => fs.readFileSync(path.join(root, file)),
        committed: files => (files.length ? files.filter(file => committed.has(file)) : []),
        ignored: files => {
          const known = asked.get(JSON.stringify(files));
          return known ? [...known.value] : ignoredPaths(root, files);
        },
        gone: files => {
          if (!files.length) return [];
          if (measurement.inHead.error) throw measuredError(measurement.inHead.error);
          return files.filter(file => !inHead.has(file));
        },
      },
    };
  }
  const { commit } = measurement,
    plan = measurement.plan.value
      ? remember(measured, measurement.plan.key, measurement.plan.value)
      : measured.get(measurement.plan.key);
  return {
    current: plan ? structuredClone(plan) : measureLine(root, line, profile, parent),
    files: {
      read: file => readAt(root, commit, file),
      committed: files => [...files],
      gone: files => [...files],
      ignored: files => {
        if (!files.length) return [];
        const known = asked.get(JSON.stringify(files)),
          key = JSON.stringify([measurement.real, commit, [...files].sort()]);
        if (ignoredAt.has(key)) return [...ignoredAt.get(key)];
        if (known?.error) throw measuredError(known.error);
        return [
          ...remember(
            ignoredAt,
            key,
            known?.value || inCommit(root, commit, parent, profile, worktree => ignoredPaths(worktree, files)),
          ),
        ];
      },
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
// The line a source story works on (see projectLine): the one the director moved it to before it started (1.1 step 2a),
// or its checks'.
export const storyLine = (store, task) =>
  projectLine(store, recordProject(task), task.release?.line ?? storyChecks(store, task)?.sourceCheck?.base?.branch);

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
// Prepares a branch and its ordered line records without publishing them. The caller can prepare several lines on
// a draft project before saving the complete change in one transaction. Existing branches are never moved.
export function prepareProjectLine(root, project, { branch, from } = {}) {
  branch = branchName(root, branch);
  const at = new Date().toISOString();
  let lines = projectLines(project);
  if (project.shipsTo && branch === project.shipsTo)
    throw new Error(`Releases ship to ${branch}, so it is not a line work lands on.`);
  if (!lines.length && !project.shipsTo) {
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
  // A release line (release/x.y) goes before the first newer one, so lines stay oldest first whichever order they
  // were made in; any other goes just before the newest line.
  const older = lines.slice(0, -1),
    series = name => /^release\/(\d+)\.(\d+)$/.exec(name)?.slice(1).map(Number),
    mine = series(branch),
    newer = mine
      ? older.findIndex(line => {
          const theirs = series(line.branch);
          return theirs && (theirs[0] - mine[0] || theirs[1] - mine[1]) > 0;
        })
      : -1,
    at_ = newer < 0 ? older.length : newer;
  const added = { branch, state: 'maintained', at, ...(from !== undefined ? { from } : {}) };
  // A project on version lines keeps every line in version order, so the newest version's line is the newest line;
  // a branch that is not a version's line goes before them.
  const prepared = project.shipsTo
    ? [...lines, added].sort((a, b) => {
        const left = series(a.branch),
          right = series(b.branch);
        return !left || !right ? (left ? 1 : 0) - (right ? 1 : 0) : left[0] - right[0] || left[1] - right[1];
      })
    : [...older.slice(0, at_), added, ...older.slice(at_), lines.at(-1)];
  return {
    lines: prepared,
    message: `Line ${branch} added${from !== undefined ? ` from ${from}` : ''} at ${commit.slice(0, 7)}; ideas can now land on it.`,
  };
}
// Adds a line for an existing branch, or for a new branch made at `from` (a tag, branch or commit). The first line
// added also records the branch the folder has checked out as the newest line; later lines go before the newest one,
// release lines in version order and others in the order they were made.
export function addProjectLine(store, projectId, runtime, options = {}) {
  const root = sourceRoot(store, projectId, runtime),
    project = store.project(projectId),
    prepared = prepareProjectLine(root, project, options);
  project.lines = prepared.lines;
  store.putProject(project);
  store.event('project_line', null, null, prepared.message, projectId);
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
