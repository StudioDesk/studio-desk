// Milestones (1.1 step 2a, Decision MP-028). A milestone is a planned release of a project on a repository: a version,
// the line its work lands on, a goal, and the ideas waiting in it. Every idea, and every story planned from it, carries
// its release, like a fix version in Jira or a milestone in GitLab. The release is picked with no extra step, from the
// first that applies: the one the director picked, a version the idea names, the planner's call (step 2b), otherwise the
// next release on the newest line. A release named before it exists is made, with its line.
//
// Where a version's work lands: a minor or major release (x.y.0) is made on the newest line; a patch (x.y.z) on
// `release/x.y`, which is made from the newest x.y tag the first time a patch needs it. Milestones are opt-in: a project
// with none, and no release tags, takes ideas exactly as before.
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

// The milestone for a version, made with its line when it does not exist yet. `by` says who asked for it.
export function makeMilestone(store, projectId, runtime, { version, goal = '', by = { type: 'director' } }) {
  const root = sourceRoot(store, projectId, runtime),
    parsed = typeof version === 'string' ? parseVersion(version) : version;
  if (!parsed) throw new Error('Name the milestone with a version such as 1.2.0.');
  if (typeof goal !== 'string' || goal.length > 2000)
    throw new Error('A milestone goal is text of at most 2000 characters.');
  const existing = projectMilestones(store, projectId).find(item => item.version === versionText(parsed));
  if (existing) return existing;
  const target = milestoneTarget(
    root,
    projectLines(store.project(projectId)),
    parsed,
    releaseTags(root),
    projectMilestones(store, projectId),
  );
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
    `Milestone ${milestone.version} made on ${milestone.line ?? 'the newest line'}${by.type === 'idea' ? `, named in an idea ("${by.named}")` : ''}.`,
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
// The next release on the newest line: its lowest open milestone, if any.
const nextRelease = milestones =>
  milestones
    .filter(item => open(item) && item.line === null)
    .sort((a, b) => compareVersions(parseVersion(a.version), parseVersion(b.version)))[0];

// The release a version written in an idea means, as its version: the open milestone of that version or series, the
// next patch of a released series, or a new minor or major release after the newest. Only a project with releases or
// milestones reads versions in ideas, and a version far beyond its own (a library's) is not its release. A full
// version (1.1.3) may need a new patch line; a short one (1.1), which an idea may mention in passing, is read only as an
// open milestone, a patch on a line that exists, or a new release on the newest line.
export function namedRelease(milestones, tags, text, lines = []) {
  if (!tags.length && !milestones.length) return null;
  const known = [...tags.map(tag => tag.version), ...milestones.map(item => parseVersion(item.version))],
    newestMajor = Math.max(...known.map(version => version[0])),
    newest = tags.at(-1)?.version;
  for (const match of String(text).matchAll(/(?<![\w.])v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?(?!\.?\d)(?!\w)/g)) {
    const version = match.slice(1, match[3] === undefined ? 3 : 4).map(Number),
      [x, y] = version,
      named = match[0];
    if (x > newestMajor + 1) continue;
    const series = seriesTags(tags, version),
      nextPatch = series.length ? [x, y, series.at(-1).version[2] + 1] : null,
      openOf = milestones
        .filter(item => open(item))
        .map(item => parseVersion(item.version))
        .filter(item => item[0] === x && item[1] === y && (version[2] === undefined || item[2] === version[2]))
        .sort(compareVersions)[0];
    if (openOf) return { version: openOf, named };
    if (version[2] === undefined) {
      if (nextPatch && lines.some(line => line.branch === `release/${x}.${y}`)) return { version: nextPatch, named };
    } else if (series.some(tag => tag.version[2] === version[2])) return { version: nextPatch, named };
    else if (nextPatch && version[2] >= nextPatch[2]) return { version, named };
    const minor = [x, y, 0];
    if (
      !series.length &&
      (version[2] === undefined || version[2] === 0) &&
      (!newest || compareVersions(minor, newest) > 0)
    )
      return { version: minor, named };
  }
  return null;
}

// The release and line a new idea takes (intake): the milestone or line the director picked, a version the idea
// names, or the next release on the newest line. `release.by` records which, so the planner (step 2b) never moves a
// release the director picked; `by` names the chooser of `milestone` when the controller sends an idea for the planner.
export function ideaRelease(store, projectId, runtime, { milestone, line, idea, by: chooser }) {
  const milestones = projectMilestones(store, projectId);
  const chosen = (picked, by) => {
    if (!open(picked)) throw new Error(`Milestone ${picked.version} is released, so no new idea lands on it.`);
    return {
      line: ideaLine(store, projectId, runtime, picked.line ?? undefined),
      release: { milestoneId: picked.id, version: picked.version, by },
    };
  };
  if (milestone !== undefined) {
    if (typeof milestone !== 'string' || !milestone) throw new Error('Choose a milestone by its ID or version.');
    const picked =
      parseVersion(milestone) && !milestones.some(item => item.id === milestone)
        ? makeMilestone(store, projectId, runtime, { version: milestone })
        : findMilestone(store, projectId, milestone);
    if (line !== undefined && line !== (picked.line ?? projectLine(store, projectId, undefined)))
      throw new Error(`Milestone ${picked.version} lands on ${picked.line ?? 'the newest line'}, not ${line}.`);
    return chosen(picked, chooser ?? { type: 'director' });
  }
  if (line !== undefined) {
    const branch = ideaLine(store, projectId, runtime, line),
      newest = branch === undefined || branch === projectLine(store, projectId, undefined),
      picked = newest
        ? nextRelease(milestones)
        : milestones
            .filter(item => open(item) && item.line === branch)
            .sort((a, b) => compareVersions(parseVersion(a.version), parseVersion(b.version)))[0];
    return {
      line: branch,
      release: picked ? { milestoneId: picked.id, version: picked.version, by: { type: 'director' } } : undefined,
    };
  }
  // Only a project with source stories reads releases in an idea's words.
  const lines = projectLines(store.project(projectId)),
    named =
      projectCatalog(store, runtime.registries, projectId).some(item => item.kind === 'studio-development:change') &&
      namedRelease(milestones, releaseTags(sourceRoot(store, projectId, runtime)), idea, lines);
  if (named) {
    const picked = makeMilestone(store, projectId, runtime, {
      version: named.version,
      by: { type: 'idea', named: named.named },
    });
    return chosen(picked, { type: 'idea', named: named.named });
  }
  const next = nextRelease(milestones);
  return {
    line: ideaLine(store, projectId, runtime, undefined),
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
