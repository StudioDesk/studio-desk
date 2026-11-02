// Milestones (1.1 step 2a, Decision MP-028). A milestone is a planned release of a project on a repository: a version,
// the line its work lands on, a goal, and the ideas waiting in it. Every idea, and every story planned from it, carries
// its release, like a fix version in Jira or a milestone in GitLab. The release is picked with no extra step: the one the
// director picked, otherwise the current working release, the lowest open milestone on the newest line. Only the
// director makes a milestone, and its line when it needs one; an idea's words and the planner never pick, move or make a
// release (MP-032, October 26).
//
// Where a version's work lands: a minor or major release (x.y.0) is made on the newest line; a patch (x.y.z) on
// `release/x.y`, which is made from the newest x.y tag the first time a patch needs it. Milestones are opt-in: a project
// with none takes ideas exactly as before.
import { randomUUID } from 'node:crypto';
import { git } from './source-integration.mjs';
import { addProjectLine, branchCommit, checkedOut, ideaLine, projectLine, projectLines } from './source-lines.mjs';
import { projectSource } from './source-projects.mjs';
import { projectCatalog } from '../core/project-organization.mjs';
import { recordProject } from '../core/projects.mjs';
import { runIdOf } from '../core/graph.mjs';

const key = projectId => 'milestones:' + projectId;
export const projectMilestones = (store, projectId) => store.setting(key(projectId)) || [];
const save = (store, projectId, milestones) => store.putSetting(key(projectId), milestones);

// A version as numbers: x.y.z, or x.y when `partial`.
export function parseVersion(text, { partial = false } = {}) {
  const match = /^v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?$/.exec(String(text).trim());
  if (!match || (!partial && match[3] === undefined)) return null;
  return match.slice(1, match[3] === undefined ? 3 : 4).map(Number);
}
export const versionText = version => version.join('.');
export const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] ?? 0) - (b[2] ?? 0);

const sourceRoot = (store, projectId, runtime) => {
  if (!projectCatalog(store, runtime.registries, projectId).some(item => item.kind === 'studio-development:change'))
    throw new Error('Only a project on the source workflow has milestones.');
  return projectSource(store, projectId, runtime).root;
};
// The repository's release tags (v1.2.3 or 1.2.3), oldest first.
export function releaseTags(root) {
  return git(root, ['tag', '--list'])
    .split('\n')
    .map(name => ({ name: name.trim(), version: parseVersion(name.trim()) }))
    .filter(tag => tag.version)
    .sort((a, b) => compareVersions(a.version, b.version));
}
const seriesTags = (tags, [x, y]) => tags.filter(tag => tag.version[0] === x && tag.version[1] === y);

// Where a new milestone's work would land: its line (null for the newest line) and, for a patch line that does not
// exist yet, the tag it starts from. The first release of a new major, while the newest line holds an older one,
// starts it there and moves the older major to a line of its own (`major`, Start 2.0); a later minor of that older
// major lands on its line.
export function milestoneTarget(root, lines, version, tags = releaseTags(root), milestones = []) {
  const text = versionText(version);
  if (tags.some(tag => compareVersions(tag.version, version) === 0)) throw new Error(`${text} is already released.`);
  if (version[2] === 0) {
    const own = `release/${version[0]}.x`;
    if (lines.some(line => line.branch === own)) return { line: own };
    const newest = tags.at(-1);
    if (newest && compareVersions(newest.version, version) > 0)
      throw new Error(`${text} is older than ${versionText(newest.version)}, the newest release.`);
    const onNewest = [
        ...tags.map(tag => tag.version),
        ...milestones
          .filter(item => item.state === 'open' && item.line === null)
          .map(item => parseVersion(item.version)),
      ],
      older = onNewest.filter(other => other[0] < version[0]);
    if (version[1] === 0 && older.length && !onNewest.some(other => other[0] >= version[0])) {
      const previous = Math.max(...older.map(other => other[0]));
      return { line: null, major: { line: `release/${previous}.x`, previous } };
    }
    return { line: null };
  }
  const series = seriesTags(tags, version),
    newest = series.at(-1),
    name = `${version[0]}.${version[1]}`;
  if (!newest) throw new Error(`${name} has no release yet, so ${text} has nothing to fix. Release ${name}.0 first.`);
  if (compareVersions(newest.version, version) > 0)
    throw new Error(`${text} is older than ${versionText(newest.version)}, the newest ${name} release.`);
  const branch = `release/${name}`;
  return lines.some(line => line.branch === branch) ? { line: branch } : { line: branch, from: newest.name };
}

// On version lines (decided by the director, November 2, 2026) a minor or major version has a line of its own,
// release/x.y, made when its milestone is: from the newest line of an older version, so it holds that version's work
// still to ship, or from the branch releases ship to when there is none.
const series = branch => /^release\/(\d+)\.(\d+)$/.exec(branch)?.slice(1).map(Number);
function versionLineTarget(project, version, tags) {
  const text = versionText(version);
  if (tags.some(tag => compareVersions(tag.version, version) === 0)) throw new Error(`${text} is already released.`);
  const newest = tags.at(-1);
  if (newest && compareVersions(newest.version, version) > 0)
    throw new Error(`${text} is older than ${versionText(newest.version)}, the newest release.`);
  const branch = `release/${version[0]}.${version[1]}`,
    lines = projectLines(project);
  if (lines.some(line => line.branch === branch)) return { line: branch };
  const older = lines.filter(line => {
    const theirs = series(line.branch);
    return theirs && (theirs[0] - version[0] || theirs[1] - version[1]) < 0;
  });
  return { line: branch, from: older.at(-1)?.branch ?? project.shipsTo };
}

// Reads the switch's destination, milestones to move and unfinished source work without changing records or git.
export function versionLinesReadiness(store, projectId, runtime) {
  const root = sourceRoot(store, projectId, runtime),
    shipsTo = projectLines(store.project(projectId)).at(-1)?.branch ?? checkedOut(root),
    milestones = projectMilestones(store, projectId),
    moving = milestones
      .filter(item => open(item) && item.line === null)
      .sort((a, b) => compareVersions(parseVersion(a.version), parseVersion(b.version)));
  // A story done before stories had stages (October 13 and 14) finished with nothing left to integrate.
  const finished = task =>
    task.kind === 'studio-development:change' && task.status === 'done' && task.sourceStage
      ? ['integrated', 'closed'].includes(task.sourceStage.current) ||
        task.sourceStage.integration?.state === 'integrated'
      : ['done', 'denied', 'cancelled'].includes(task.status);
  const busy = store
    .tasks()
    .filter(
      task => recordProject(task) === projectId && task.kind?.startsWith('studio-development:') && !finished(task),
    );
  const needs = [];
  if (!moving.length) needs.push({ kind: 'next-version' });
  if (busy.length)
    needs.push({
      kind: 'open-work',
      tasks: busy.slice(0, 5).map(task => ({ id: task.id, title: task.title })),
      count: busy.length,
    });
  return { shipsTo, milestones, moving, busy, ready: needs.length === 0, needs };
}

// Switches a project to version lines: releases ship to `shipsTo`, which stops being a line work lands on, and each
// open milestone on it gets a line of its own, in version order, each made from the one before (the first from
// `shipsTo`'s tip); a branch of that name that already exists is used as it is. Refused while work on `shipsTo` is
// still open, which would be left without a line, and with no open version to land new work on.
export function useVersionLines(store, projectId, runtime, { shipsTo } = {}) {
  const root = sourceRoot(store, projectId, runtime),
    project = store.project(projectId);
  if (project.shipsTo) throw new Error(`This project already ships to ${project.shipsTo}.`);
  if (typeof shipsTo !== 'string' || !shipsTo) throw new Error('Name the branch releases ship to, such as main.');
  try {
    branchCommit(root, shipsTo);
  } catch {
    throw new Error(`The repository has no branch named ${shipsTo}.`);
  }
  const { shipsTo: current, milestones: all, moving, busy } = versionLinesReadiness(store, projectId, runtime);
  if (current !== shipsTo)
    throw new Error(`New releases are made on ${current}, so that is the branch they ship to. Name ${current}.`);
  if (!moving.length) throw new Error("Make the next version's milestone first, so new work has a line to land on.");
  if (busy.length)
    throw new Error(
      `Finish or close the open work first (${busy
        .slice(0, 5)
        .map(task => task.id)
        .join(', ')}${busy.length > 5 ? ', …' : ''}): it would be left on ${shipsTo} without a line.`,
    );
  project.shipsTo = shipsTo;
  project.lines = projectLines(project).filter(line => line.branch !== shipsTo);
  store.putProject(project);
  let from = shipsTo;
  for (const milestone of moving) {
    const version = parseVersion(milestone.version),
      branch = `release/${version[0]}.${version[1]}`;
    let exists = true;
    try {
      branchCommit(root, branch);
    } catch {
      exists = false;
    }
    if (!projectLines(store.project(projectId)).some(line => line.branch === branch))
      addProjectLine(store, projectId, runtime, exists ? { branch } : { branch, from });
    milestone.line = branch;
    from = branch;
  }
  save(store, projectId, all);
  store.event(
    'version_lines',
    null,
    null,
    `Each version now has its own line, and releases ship to ${shipsTo}: ${moving.map(item => `${item.version} on ${item.line}`).join(', ')}.`,
    projectId,
  );
  return { shipsTo, lines: projectLines(store.project(projectId)), milestones: projectMilestones(store, projectId) };
}

// The milestone for a version, made with its line when it does not exist yet. `by` says who asked for it.
export function makeMilestone(store, projectId, runtime, { version, goal = '', by = { type: 'director' } }) {
  const root = sourceRoot(store, projectId, runtime),
    parsed = typeof version === 'string' ? parseVersion(version) : version;
  if (!parsed) throw new Error('Name the milestone with a version such as 1.2.0.');
  if (typeof goal !== 'string' || goal.length > 2000)
    throw new Error('A milestone goal is text of at most 2000 characters.');
  const existing = projectMilestones(store, projectId).find(item => item.version === versionText(parsed));
  if (existing) return existing;
  const project = store.project(projectId),
    target =
      project.shipsTo && parsed[2] === 0
        ? versionLineTarget(project, parsed, releaseTags(root))
        : milestoneTarget(root, projectLines(project), parsed, releaseTags(root), projectMilestones(store, projectId));
  // Start 2.0: the older major continues on its own line, made from the newest line's tip, with its open milestones.
  if (target.major) {
    const newest = projectLine(store, projectId, undefined) ?? checkedOut(root);
    if (!newest) throw new Error('Check out the branch new releases are made on before starting a new major release.');
    let exists = true;
    try {
      branchCommit(root, target.major.line);
    } catch {
      exists = false;
    }
    addProjectLine(
      store,
      projectId,
      runtime,
      exists ? { branch: target.major.line } : { branch: target.major.line, from: newest },
    );
    const all = projectMilestones(store, projectId);
    for (const item of all)
      if (item.state === 'open' && item.line === null && parseVersion(item.version)[0] <= target.major.previous)
        item.line = target.major.line;
    save(store, projectId, all);
    store.event(
      'major_started',
      null,
      null,
      `${versionText(parsed)} starts on ${newest}; ${target.major.previous}.x continues on ${target.major.line}, made from ${newest}'s tip.`,
      projectId,
    );
  }
  if (target.from !== undefined) {
    let exists = true;
    try {
      branchCommit(root, target.line);
    } catch {
      exists = false;
    }
    addProjectLine(
      store,
      projectId,
      runtime,
      exists ? { branch: target.line } : { branch: target.line, from: target.from },
    );
  }
  const milestone = {
    id: 'milestone-' + randomUUID().slice(0, 8),
    version: versionText(parsed),
    line: target.line,
    goal: goal.trim(),
    state: 'open',
    at: new Date().toISOString(),
    by,
    waiting: [],
  };
  save(store, projectId, [...projectMilestones(store, projectId), milestone]);
  store.event(
    'milestone_made',
    null,
    null,
    `Milestone ${milestone.version} made on ${milestone.line ?? 'the newest line'}.`,
    projectId,
  );
  return milestone;
}
export function editMilestone(store, projectId, { id, goal }) {
  const milestones = projectMilestones(store, projectId),
    milestone = milestones.find(item => item.id === id);
  if (!milestone) throw new Error('Milestone not found.');
  if (typeof goal !== 'string' || goal.length > 2000)
    throw new Error('A milestone goal is text of at most 2000 characters.');
  milestone.goal = goal.trim();
  save(store, projectId, milestones);
  return milestone;
}
// A milestone named by its ID or its version.
function findMilestone(store, projectId, named) {
  const milestones = projectMilestones(store, projectId),
    milestone = milestones.find(item => item.id === named || item.version === named);
  if (!milestone) throw new Error(`${named} is not a milestone of this project.`);
  return milestone;
}
const open = milestone => milestone.state === 'open';
// The next release on the newest line: its lowest open milestone, if any. On version lines it is the lowest open
// minor or major version, on whichever line it has.
const nextRelease = (milestones, shipsTo) =>
  milestones
    .filter(item => open(item) && (shipsTo ? parseVersion(item.version)[2] === 0 : item.line === null))
    .sort((a, b) => compareVersions(parseVersion(a.version), parseVersion(b.version)))[0];

// The release and line a new idea takes (intake): the milestone or line the director picked, otherwise the current
// working release, the next one on the newest line. Its words are never read for a version, and the planner never moves
// it: only the director picks a release (MP-032). `release.by` records which.
export function ideaRelease(store, projectId, runtime, { milestone, line }) {
  const milestones = projectMilestones(store, projectId);
  if (milestone !== undefined) {
    if (typeof milestone !== 'string' || !milestone) throw new Error('Choose a milestone by its ID or version.');
    const picked =
      parseVersion(milestone) && !milestones.some(item => item.id === milestone)
        ? makeMilestone(store, projectId, runtime, { version: milestone })
        : findMilestone(store, projectId, milestone);
    if (line !== undefined && line !== (picked.line ?? projectLine(store, projectId, undefined)))
      throw new Error(`Milestone ${picked.version} lands on ${picked.line ?? 'the newest line'}, not ${line}.`);
    if (!open(picked)) throw new Error(`Milestone ${picked.version} is released, so no new idea lands on it.`);
    return {
      line: ideaLine(store, projectId, runtime, picked.line ?? undefined),
      release: { milestoneId: picked.id, version: picked.version, by: { type: 'director' } },
    };
  }
  if (line !== undefined) {
    const branch = ideaLine(store, projectId, runtime, line),
      newest = branch === undefined || branch === projectLine(store, projectId, undefined),
      picked = newest
        ? nextRelease(milestones, store.project(projectId).shipsTo)
        : milestones
            .filter(item => open(item) && item.line === branch)
            .sort((a, b) => compareVersions(parseVersion(a.version), parseVersion(b.version)))[0];
    return {
      line: branch,
      release: picked ? { milestoneId: picked.id, version: picked.version, by: { type: 'director' } } : undefined,
    };
  }
  const next = nextRelease(milestones, store.project(projectId).shipsTo);
  return {
    line: ideaLine(store, projectId, runtime, next?.line ?? undefined),
    release: next ? { milestoneId: next.id, version: next.version, by: { type: 'default' } } : undefined,
  };
}

// A task's release: its own, when the director moved it, or its run's.
export function taskRelease(store, task) {
  return task.release || store.run(runIdOf(task))?.release;
}
// Moves a story that has not started to another milestone. A milestone on another line moves the story's work there,
// which needs no story of its idea to depend on it or it on one.
export function moveStory(store, runtime, task, milestoneId) {
  const projectId = recordProject(task);
  if (task.kind !== 'studio-development:change') throw new Error('Only a source story moves between releases.');
  if (store.attempts(task.id).some(attempt => (attempt.assignment?.kind || task.kind) === 'studio-development:change'))
    throw new Error(
      'This story has started, so its work stays on its branch; newer releases get it when it is carried forward.',
    );
  const milestone = findMilestone(store, projectId, milestoneId);
  if (!open(milestone)) throw new Error(`Milestone ${milestone.version} is released, so no story moves to it.`);
  const line = projectLine(store, projectId, milestone.line ?? undefined),
    current = task.release?.line ?? store.run(runIdOf(task))?.line ?? projectLine(store, projectId, undefined);
  if (line !== current) {
    const linked = store
      .tasks()
      .filter(
        other =>
          other.kind === 'studio-development:change' &&
          recordProject(other) === projectId &&
          (task.dependencies.includes(other.id) || other.dependencies.includes(task.id)),
      );
    if (linked.length)
      throw new Error(
        `This story is linked to ${linked.map(other => other.id).join(', ')} on its branch, so it cannot move to ${line} on its own.`,
      );
  }
  task.release = {
    milestoneId: milestone.id,
    version: milestone.version,
    by: { type: 'director' },
    at: new Date().toISOString(),
    ...(line !== undefined ? { line } : {}),
  };
  return task;
}

// Ideas written into a milestone and sent later: by the director, or by the autonomy setting that sends a milestone's
// next waiting idea when its line is free.
export function addWaitingIdea(store, projectId, { milestoneId, idea, autoMode }) {
  const milestones = projectMilestones(store, projectId),
    milestone = milestones.find(item => item.id === milestoneId);
  if (!milestone) throw new Error('Milestone not found.');
  if (!open(milestone)) throw new Error(`Milestone ${milestone.version} is released, so no idea waits in it.`);
  if (typeof idea !== 'string' || !idea.trim() || idea.trim().length > 4000)
    throw new Error('Idea must be nonempty text of at most 4000 characters after trimming.');
  if (autoMode !== undefined && autoMode !== null && typeof autoMode !== 'boolean')
    throw new Error('Auto mode must be true, false or null.');
  if (milestone.waiting.length >= 100) throw new Error('A milestone holds at most 100 waiting ideas.');
  const waiting = {
    id: 'waiting-' + randomUUID().slice(0, 8),
    idea: idea.trim(),
    ...(typeof autoMode === 'boolean' ? { autoMode } : {}),
    at: new Date().toISOString(),
  };
  milestone.waiting.push(waiting);
  save(store, projectId, milestones);
  store.event('idea_waiting', null, null, `An idea waits in milestone ${milestone.version}.`, projectId);
  return waiting;
}
// Takes a waiting idea out of its milestone, returning it with the milestone and the place it held.
export function takeWaitingIdea(store, projectId, milestoneId, waitingId) {
  const milestones = projectMilestones(store, projectId),
    milestone = milestones.find(item => item.id === milestoneId),
    index = milestone ? milestone.waiting.findIndex(item => item.id === waitingId) : -1;
  if (index < 0) throw new Error('Waiting idea not found.');
  const [waiting] = milestone.waiting.splice(index, 1);
  save(store, projectId, milestones);
  return { milestone, waiting, index };
}
// Puts a waiting idea back in the place it held, when sending it failed.
export function restoreWaitingIdea(store, projectId, milestoneId, waiting, index = 0) {
  const milestones = projectMilestones(store, projectId),
    milestone = milestones.find(item => item.id === milestoneId);
  if (!milestone) return;
  milestone.waiting.splice(Math.min(index, milestone.waiting.length), 0, waiting);
  save(store, projectId, milestones);
}
// Ideas wait in the order they are sent (1.1 step 6): the director moves one to another place in its milestone.
export function orderWaitingIdea(store, projectId, milestoneId, waitingId, index) {
  const milestones = projectMilestones(store, projectId),
    milestone = milestones.find(item => item.id === milestoneId),
    from = milestone ? milestone.waiting.findIndex(item => item.id === waitingId) : -1;
  if (from < 0) throw new Error('Waiting idea not found.');
  if (!Number.isSafeInteger(index) || index < 0 || index >= milestone.waiting.length)
    throw new Error(`A waiting idea's place is a whole number from 0 to ${milestone.waiting.length - 1}.`);
  const [waiting] = milestone.waiting.splice(from, 1);
  milestone.waiting.splice(index, 0, waiting);
  save(store, projectId, milestones);
  return milestone;
}
// Moves a waiting idea to the end of another open milestone's ideas (1.1 step 6). Its line follows its milestone when
// it is sent, so moving it is only a record.
export function moveWaitingIdea(store, projectId, milestoneId, waitingId, toMilestone) {
  const milestones = projectMilestones(store, projectId),
    milestone = milestones.find(item => item.id === milestoneId),
    target = milestones.find(item => item.id === toMilestone || item.version === toMilestone),
    index = milestone ? milestone.waiting.findIndex(item => item.id === waitingId) : -1;
  if (index < 0) throw new Error('Waiting idea not found.');
  if (!target) throw new Error(`${toMilestone} is not a milestone of this project.`);
  if (target === milestone) return target;
  if (!open(target)) throw new Error(`Milestone ${target.version} is released, so no idea waits in it.`);
  if (target.waiting.length >= 100) throw new Error('A milestone holds at most 100 waiting ideas.');
  const [waiting] = milestone.waiting.splice(index, 1);
  target.waiting.push(waiting);
  save(store, projectId, milestones);
  store.event(
    'idea_moved',
    null,
    null,
    `A waiting idea moved from milestone ${milestone.version} to ${target.version}.`,
    projectId,
  );
  return target;
}
