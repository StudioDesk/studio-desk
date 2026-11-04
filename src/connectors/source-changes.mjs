// Shared controller operations. Workers never receive the live source target.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, validateResult, validateComplexity } from '../core/contracts.mjs';
import { artifactPath, acceptedReference, validateAcceptedReferences } from '../core/artifacts.mjs';
import { recordProject, jobDirectory, assertProject } from '../core/projects.mjs';
import { projectOrganization } from '../core/project-organization.mjs';
import { isRoleId } from '../core/staffing.mjs';
import { readContinuation } from '../core/attempt-continuation.mjs';
import { sourcePlan, testsSentence, validateCheckReport } from './source-checks.mjs';
import {
  measuringLimits,
  profileOf,
  recordedProfile,
  storyPathAllowed,
  storyPathRule,
  studioDeskProfile,
} from './source-profile.mjs';
import { reviewedImages, reviewVisualProblems, validateStoryPages } from './story-pages.mjs';
import { sourceResources, sourceRoot, studioDeskSourceResources } from './source-projects.mjs';
import { sourceDiffFormat, sourceDiffLimit, verifySourceDiff } from './source-diff.mjs';
import { codexSandboxRecord, sandboxRecord, testSandboxOf } from '../adapters/source-test-sandbox.mjs';
import { builtInSandboxRunner } from '../adapters/built-in-sandbox.mjs';
import { live } from '../adapters/process.mjs';
import { testTurnResource } from '../core/test-turn.mjs';
import {
  commitIntegration,
  committedIntegration,
  git,
  integrationTrailer,
  landedSince,
  statusPaths,
  verifyCandidateCommit,
  verifyIntegration,
  observeIntegrationPhase,
} from './source-integration.mjs';
import { createSourceWorktree, removeSourceWorktree, sourceWorktreeRoot, worktreeName } from './source-worktrees.mjs';
import {
  lineBase,
  lineFiles,
  lineReached,
  lineRepository,
  measureLine,
  moveLine,
  projectLine,
  storyLine,
} from './source-lines.mjs';
import { interruptedCarries, planCarries } from './source-carries.mjs';
import { interruptedReleases } from './source-releases.mjs';

export const sourceChangesConnector = Object.freeze({
  id: 'local-source-changes',
  version: 'source-changes-v1',
  resource: 'source:studio-desk-integration',
});
// A Studio desk integration holds these exclusively, and a pending one goes next on them; a project
// with its own repository holds that repository's (sourceResources).
export const sourceIntegrationResources = studioDeskSourceResources;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Where a release line that is not checked out is measured, in a worktree removed at once (src/connectors/source-lines.mjs).
const measureParent = store => path.join(store.directory, 'wt');
// The measurements of the open measuring pass, by root, line and profile, or null outside one.
let pass = null;
// Runs fn as one measuring pass (a scheduler pass, a readiness refresh, or a director's start): every story checked in
// it reuses the first measurement of the same root, line and profile, which of the same files are committed, ignored or
// deleted, and the commit a story would start from, instead of reading and hashing the whole live source and asking git
// again for each check. A pass opened inside one joins it. Outside a pass every check measures.
export function measuringPass(fn) {
  if (pass) return fn();
  pass = new Map();
  try {
    return fn();
  } finally {
    pass = null;
  }
}
// An attempt that claimed a line ends the reuse: the checks after it in the pass measure again.
export function measureAgain() {
  pass?.clear();
}
// One measurement of a line for the rest of the pass, asking git once for each list of files whose commits, ignore
// rules or deletions it checks.
function passMeasurement({ current, files }) {
  const asked = { committed: new Map(), ignored: new Map(), gone: new Map() },
    once = name => paths => {
      const key = JSON.stringify(paths);
      if (!asked[name].has(key)) asked[name].set(key, files[name](paths));
      return [...asked[name].get(key)];
    };
  return {
    current,
    files: { ...files, committed: once('committed'), ignored: once('ignored'), gone: once('gone') },
  };
}
// The commit a story on the line would start from, asked of git once in a pass; a source that cannot start a story
// says why to each story that asks.
function passBase(root, line, profile) {
  if (!pass) return lineBase(root, line, profile);
  const key = JSON.stringify(['base', root, line ?? null, profile]);
  if (!pass.has(key))
    try {
      pass.set(key, { base: lineBase(root, line, profile) });
    } catch (error) {
      pass.set(key, { error });
    }
  const { base, error } = pass.get(key);
  if (error) throw error;
  return structuredClone(base);
}
// The source a story's scope is checked against: its project's line as its measured checks recorded it, or the one the
// director moved the story to before it started (1.1 step 2a). In a measuring pass, as the pass first measured it.
function storySource(store, projectId, root, sourceCheck, profile, task) {
  const line = projectLine(store, projectId, task?.release?.line ?? sourceCheck.base?.branch),
    measure = () => ({
      current: measureLine(root, line, profile, measureParent(store)),
      files: lineFiles(root, line, profile, measureParent(store)),
    });
  if (!pass) return { line, ...measure() };
  const key = JSON.stringify([root, line ?? null, profile]);
  if (!pass.has(key)) pass.set(key, passMeasurement(measure()));
  const { current, files } = pass.get(key);
  return { line, current: structuredClone(current), files };
}
function closedFields(value, allowed, name) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    throw new Error(`${name} contains unsupported fields.`);
}
function boundedText(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name} must contain bounded nonempty text.`);
}

// This contract contains intent only. Execution limits, resources and accepted
// input identities are supplied by the controller, never by a planning model.
export function validateBreakdown(plan, source) {
  closedFields(plan, ['schemaVersion', 'source', 'summary', 'stories'], 'Source breakdown');
  if (plan.schemaVersion !== 'source-breakdown-v1') throw new Error('schemaVersion must be source-breakdown-v1.');
  const identity = ['taskId', 'attemptId', 'path', 'hash', 'sourceHash', 'contextPath', 'contextHash'];
  closedFields(plan.source, identity, 'Breakdown source');
  for (const key of identity)
    if (!source || plan.source[key] !== source[key])
      throw new Error(
        `Breakdown source.${key} must be ${source?.[key]} from the recorded accepted source-check evidence.` +
          (key === 'path' || key === 'contextPath'
            ? ' Use the recorded artifact file name, not the location of its staged copy under ../inputs.'
            : ''),
      );
  boundedText(plan.summary, 4000, 'Breakdown summary');
  if (!Array.isArray(plan.stories) || plan.stories.length < 1 || plan.stories.length > 10)
    throw new Error('A breakdown needs 1 to 10 stories; split larger ideas into separate breakdowns.');
  const keys = new Set(),
    byKey = new Map();
  for (const story of plan.stories) {
    closedFields(
      story,
      [
        'key',
        'kind',
        'workerId',
        'role',
        'title',
        'scope',
        'acceptance',
        'complexity',
        'dependencies',
        'files',
        'newFiles',
        'deleteFiles',
        'release',
        'releaseReason',
        'pages',
        'summary',
      ],
      'Breakdown story',
    );
    // The pages an interface story's visual check captures (1.2 step 8): the planner proposes them from its spec.
    if (story.pages !== undefined) validateStoryPages(story.pages, `Story ${story.key}: pages`);
    // The release a story belongs on (1.1 step 2b), as a version, with why; the controller decides what it does.
    if (
      story.release !== undefined &&
      (typeof story.release !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(story.release))
    )
      throw new Error(`Story ${story.key}: release must be a version such as 1.1.3.`);
    if (story.releaseReason !== undefined) {
      if (story.release === undefined) throw new Error(`Story ${story.key}: give releaseReason only with a release.`);
      boundedText(story.releaseReason, 1000, `Story ${story.key} releaseReason`);
    }
    if (
      typeof story.key !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,40}$/.test(story.key) ||
      ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(story.key) ||
      keys.has(story.key)
    )
      throw new Error('Breakdown story keys must be unique stable safe identifiers (1 to 40 letters, digits, _ or -).');
    keys.add(story.key);
    byKey.set(story.key, story);
    if (story.kind !== 'studio-development:change')
      throw new Error(`Story ${story.key}: kind must be studio-development:change.`);
    // A story names the staffing role that should do it (MP-015), or one employee.
    if ((story.role === undefined) === (story.workerId === undefined))
      throw new Error(`Story ${story.key}: name either a staffing role or one employee (workerId).`);
    if (story.role !== undefined && !isRoleId(story.role))
      throw new Error(`Story ${story.key}: role must be a role ID from the roster.`);
    if (story.workerId !== undefined) boundedText(story.workerId, 80, `Story ${story.key} workerId`);
    boundedText(story.title, 160, `Story ${story.key} title`);
    boundedText(story.scope, 8000, `Story ${story.key} scope`);
    boundedText(story.acceptance, 8000, `Story ${story.key} acceptance`);
    // What the story does and why in plain words, for the director (November 1, 2026); optional for older planners.
    if (story.summary !== undefined) boundedText(story.summary, 400, `Story ${story.key} summary`);
    validateComplexity(story.complexity);
    if (
      !Array.isArray(story.dependencies) ||
      story.dependencies.length > 9 ||
      new Set(story.dependencies).size !== story.dependencies.length ||
      story.dependencies.some(key => typeof key !== 'string')
    )
      throw new Error(`Story ${story.key}: dependencies must be distinct sibling story keys.`);
    validateStoryPaths(story, source.files, `Story ${story.key}`, profileOf(source));
  }
  const visiting = new Set(),
    visited = new Set();
  const visit = key => {
    if (!keys.has(key)) throw new Error(`Breakdown references missing prerequisite ${key}; use a sibling key.`);
    if (visiting.has(key)) throw new Error(`Breakdown dependencies contain a cycle at ${key}.`);
    if (visited.has(key)) return;
    visiting.add(key);
    byKey.get(key).dependencies.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  };
  keys.forEach(visit);
  return plan;
}

// The paths a story may change (MP-016 slice 2): existing files to edit (files), files to create
// (newFiles) and existing files the controller deletes when it builds the candidate (deleteFiles).
// The approved list is the scope; its length is only bounded to keep records small. How much a
// story changes is bounded by its diff (sourceDiffLimit) and its complexity's time limit.
export const maxScopePaths = 100;
// The profile's source folders and text types only (storyPathAllowed). Its protected names (for
// Studio desk: instruction files, the package manifest and formatter configuration) and dot-paths
// can never be created, changed or deleted by a story.
const scopePaths = ({ files, newFiles = [], deleteFiles = [] }) => ({ files, newFiles, deleteFiles });
// A scope refusal only a new breakdown can fix, since the source moved past the story's plan (error.outdated, with the
// files involved): an approved file that no longer exists, a file to create that now exists or collides and no
// prerequisite in the chain created, or a listed file the source holds that its measured list lacks. Uncommitted
// edits, git-ignored paths and edit counts are refusals the director can fix in place, and carry no marker.
const outdatedError = (message, files) => Object.assign(new Error(message), { outdated: { files: [...files] } });
// What a story whose plan the source moved past says to the director, in plain words (sourceStage.outdated).
export const outdatedReason =
  'The code moved on since this story was planned: another story has since created or changed files it was planned to create or change. Close it and send its remaining work as a new idea.';
// Notes on a story that its plan is out of date when error is such a refusal: { reason, files, at }, the files of every
// such refusal so far and when the latest was seen. It is never cleared, since editing the story cannot fix it. Returns
// whether it noted anything; a story from before stages (with a separate review task) gains no stage.
export function noteOutdated(task, error) {
  if (task?.kind !== 'studio-development:change' || !error?.outdated?.files?.length) return false;
  if (!task.sourceStage && task.proposedTaskIds?.length) return false;
  task.sourceStage ||= newSourceStage();
  const files = [...new Set([...(task.sourceStage.outdated?.files || []), ...error.outdated.files])];
  task.sourceStage.outdated = { reason: outdatedReason, files, at: new Date().toISOString() };
  return true;
}
// Notes it on the recorded story, for a refusal outside a start (an edit, or the check of a file request).
function recordOutdated(store, taskId, error) {
  if (!error?.outdated) return;
  const task = store.task(taskId);
  if (noteOutdated(task, error)) store.putTask(task);
}
// New files must not exist, ignoring case (Windows), nor sit where a file or folder already is.
function newPathProblem(file, taken) {
  const lower = file.toLowerCase(),
    parents = lower
      .split('/')
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  if (taken.files.has(lower) || taken.folders.has(lower) || parents.some(parent => taken.files.has(parent)))
    return 'it already exists or collides with an existing path; list an existing file under files to edit it';
  taken.files.add(lower);
  for (const parent of parents) taken.folders.add(parent);
}
function takenPaths(manifest) {
  const taken = { files: new Set(), folders: new Set() };
  for (const item of manifest) newPathProblem(item.path, taken);
  return taken;
}
export function validateStoryPaths(paths, manifest = [], name = 'The story', profile = studioDeskProfile) {
  const { files, newFiles, deleteFiles } = scopePaths(paths || {});
  if (![files, newFiles, deleteFiles].every(Array.isArray))
    throw new Error(`${name} must list files, newFiles and deleteFiles as arrays of source paths.`);
  const all = [...files, ...newFiles, ...deleteFiles];
  if (!all.length || all.length > maxScopePaths)
    throw new Error(
      `${name} must list 1 to ${maxScopePaths} source paths in total across files, newFiles and deleteFiles.`,
    );
  if (new Set(all).size !== all.length)
    throw new Error(`${name} must list each source path once, in only one of files, newFiles and deleteFiles.`);
  const recorded = file => manifest.some(item => item.path === file);
  for (const file of [...files, ...deleteFiles])
    if (!storyPathAllowed(file, profile) || !recorded(file)) {
      const message = `${name} lists unsupported or unrecorded source file ${String(file)}; choose an allowed existing path from the measured manifest.`;
      // An allowed path the measured list lacks may be one the source gained since it was measured (verifyStoryScope).
      throw storyPathAllowed(file, profile)
        ? outdatedError(
            message,
            [...files, ...deleteFiles].filter(other => storyPathAllowed(other, profile) && !recorded(other)),
          )
        : new Error(message);
    }
  const taken = takenPaths(manifest);
  for (const file of newFiles) {
    const problem = storyPathAllowed(file, profile) ? newPathProblem(file, taken) : storyPathRule(profile);
    if (problem) throw new Error(`${name} cannot create ${String(file)}: ${problem}.`);
  }
}
// How a story's paths read in its brief. Stories that only edit keep their earlier brief.
export function scopeFilesText(paths) {
  const { files, newFiles, deleteFiles } = scopePaths(paths);
  return [
    files.length ? `Files: ${files.join(', ')}` : '',
    newFiles.length ? `New files: ${newFiles.join(', ')}` : '',
    deleteFiles.length ? `Delete: ${deleteFiles.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function replaceFile(root, relative, contents, id) {
  // Write beside the fixed source allowlist, then atomically replace one file.
  // A crash cannot leave a partially written target. Multi-file recovery is
  // explicitly journaled and never replayed on startup.
  const temporary = path.join(root, '.studio-source-' + id + '.tmp');
  fs.writeFileSync(temporary, contents, { flag: 'wx' });
  fs.renameSync(temporary, path.join(root, relative));
}
const identity = (ref, name) => {
  const item = ref.artifacts.find(item => item.path === name);
  if (!item) throw new Error('Required source artifact is missing.');
  return { taskId: ref.taskId, attemptId: ref.attemptId, path: item.path, hash: item.hash };
};
// All paths come from registered accepted artifacts and controller snapshots.
// The model can only repeat these identities, never choose another source root.
export function measuredSourceEvidence(store, taskId, attemptId, projectId) {
  const ref = acceptedReference(store, taskId, attemptId, projectId),
    checked = store.attempt(ref.attemptId),
    reportIdentity = identity(ref, 'check-report.json'),
    contextIdentity = identity(ref, 'source-context.json');
  if (
    checked.assignment?.kind !== 'studio-development:checks' ||
    store.task(taskId).kind !== 'studio-development:checks' ||
    checked.checkExecution?.fixture !== false ||
    !checked.sourceCheck ||
    !ref.artifacts.some(item => item.path === reportIdentity.path && item.kind === 'source-check-report') ||
    !ref.artifacts.some(item => item.path === contextIdentity.path && item.kind === 'source-context')
  )
    throw new Error(
      'Breakdown requires one accepted measured source-check report and source-context, not fixture evidence.',
    );
  const read = name => fs.readFileSync(artifactPath(store, checked, name), 'utf8');
  for (const name of ['test-output.txt', 'test-errors.txt'])
    if (!ref.artifacts.some(item => item.path === name)) throw new Error(`Measured evidence is missing ${name}.`);
  const report = JSON.parse(read(reportIdentity.path));
  validateCheckReport(
    report,
    checked.sourceCheck,
    checked.checkExecution,
    read('test-output.txt'),
    read('test-errors.txt'),
  );
  if (checked.sourceCheck.sourceHash !== hash(JSON.stringify(checked.sourceCheck.files)))
    throw new Error('Measured source manifest identity changed. Request fresh checks.');
  const context = JSON.parse(read(contextIdentity.path));
  if (
    context.schemaVersion !== 'source-context-v1' ||
    context.sourceHash !== report.source.hash ||
    !Array.isArray(context.documents) ||
    !context.documents.length ||
    new Set(context.documents.map(doc => doc.path)).size !== context.documents.length ||
    context.documents.some(
      doc =>
        typeof doc.text !== 'string' ||
        hash(doc.text) !== doc.hash ||
        !report.source.files.some(item => item.path === doc.path && item.hash === doc.hash),
    )
  )
    throw new Error('Measured source context no longer matches the recorded source identity. Request fresh checks.');
  return {
    ...reportIdentity,
    sourceHash: report.source.hash,
    contextPath: contextIdentity.path,
    contextHash: contextIdentity.hash,
    files: structuredClone(report.source.files),
    // The profile the checks measured with, so stories are held to its path rules.
    ...recordedProfile(profileOf(checked.sourceCheck)),
  };
}

// pathsOf gives a story's current paths, which the director's latest edit replaces (editSourceStory).
export function breakdownEvidence(
  store,
  attempt,
  projectId,
  storyKey,
  pathsOf = story => story,
  { earlier = false } = {},
) {
  const pinned = attempt.sourceBreakdown;
  if (!pinned) throw new Error('Recorded breakdown source evidence is missing. Request a fresh breakdown.');
  if (
    attempt.assignment?.kind !== 'studio-development:breakdown' ||
    attempt.assignment.dependencies?.length !== 1 ||
    attempt.assignment.dependencies[0] !== pinned.taskId
  )
    throw new Error('Breakdown must record exactly its producing accepted source-check prerequisite.');
  const source = measuredSourceEvidence(store, pinned.taskId, pinned.attemptId, projectId);
  if (!equal(source, pinned))
    throw new Error('Recorded breakdown/check source identities changed. Request fresh evidence.');
  const report = JSON.parse(fs.readFileSync(artifactPath(store, attempt, 'source-breakdown.json')));
  validateBreakdown(report, source);
  const checked = store.attempt(source.attemptId),
    { current, files } = storySource(
      store,
      projectId,
      checked.sourceCheck.root,
      checked.sourceCheck,
      profileOf(checked.sourceCheck),
    );
  // Validate every story before common intake writes even the first draft.
  if (storyKey !== undefined && !report.stories.some(story => story.key === storyKey))
    throw new Error('The exact proposalReference.key is missing from the accepted breakdown.');
  // A story's files may already carry changes integrated stories committed, and a new file may be
  // one its integrated prerequisite stories created.
  const integrated = integratedSourceChanges(store, current.root);
  for (const story of report.stories.filter(story => storyKey === undefined || story.key === storyKey)) {
    const siblings = story.dependencies
      .map(
        key =>
          store
            .tasks()
            .find(
              task =>
                task.proposalReference?.attemptId === attempt.id &&
                task.proposalReference.key === key &&
                recordProject(task) === projectId,
            )?.id,
      )
      .filter(Boolean);
    verifyStoryScope(pathsOf(story), current, source.files, {
      integrated,
      created: integratedChanges(store, siblings),
      files,
      earlier,
    });
  }
  return { report, source, checkedReference: acceptedReference(store, source.taskId, source.attemptId, projectId) };
}

const staleBreakdown = { since: 'the breakdown', action: 'Request fresh measured evidence and a new breakdown.' };
const named = files => files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');
// Whether the story's integrated prerequisite stories created file (created, from integratedChanges) and the current
// source still holds what they left (MP-014 slice 4).
const createdByChain = (file, current, created) => {
  const item = current.files.find(item => item.path === file);
  return !!item && !!created.get(file)?.has(item.hash);
};
// Checks a story's paths against the current source and returns the scope to dispatch. A file may
// differ from the measured bytes by a change an integrated story committed (MP-016 slice 4), whose
// hash an integration into this source left, or by any change committed on the development copy's
// branch (MP-021): the editor starts from the current commit and integration merges. A listed file
// that is gone, or that holds uncommitted edits, still stops the story. `files` reads the line the
// story measured (src/connectors/source-lines.mjs), by default the checked-out folder. A new file the story's
// integrated prerequisite stories created is edited like any other existing file (MP-014 slice 4);
// other new files must still be absent, and not ignored by git. For a story with earlier work (`earlier`, October
// 27), a listed file a commit on its line deleted since is left out of this attempt and named in `deletedSince`, and
// the earlier work on it is set aside for the editor, rather than the story stopping.
function verifyStoryScope(
  paths,
  current,
  original,
  {
    integrated = new Map(),
    created: prerequisites = new Map(),
    files: line = lineFiles(current.root),
    earlier = false,
  } = {},
  stale = staleBreakdown,
) {
  try {
    validateStoryPaths(paths, original, undefined, profileOf(current));
  } catch (error) {
    // Only a listed file the source holds now is one it gained since the plan; another is a path that never was.
    const gained = (error.outdated?.files || []).filter(file => current.files.some(item => item.path === file));
    if (gained.length) error.outdated.files = gained;
    else delete error.outdated;
    throw error;
  }
  const { files, newFiles, deleteFiles } = scopePaths(paths),
    now = file => current.files.find(item => item.path === file),
    created = newFiles.filter(file => createdByChain(file, current, prerequisites)),
    absent = newFiles.filter(file => !created.includes(file));
  const absentNow = [...files, ...deleteFiles].filter(file => !now(file)),
    gone = earlier && absentNow.length ? line.gone(absentNow) : [],
    missing = absentNow.filter(file => !gone.includes(file)),
    drifted = [...files, ...deleteFiles].filter(file => {
      const item = now(file),
        before = original.find(item => item.path === file);
      return (
        item && (item.hash !== before.hash || item.bytes !== before.bytes) && !integrated.get(file)?.has(item.hash)
      );
    }),
    committed = line.committed(drifted),
    uncommitted = drifted.filter(file => !committed.includes(file));
  if (missing.length) {
    const message = `Approved source files no longer exist: ${named(missing)}. ${stale.action}`,
      // A deletion committed on the line moved the source past the plan; an uncommitted one can still be restored.
      deleted = line.gone(missing);
    throw deleted.length ? outdatedError(message, deleted) : new Error(message);
  }
  if (uncommitted.length)
    throw new Error(
      `Approved source files changed since ${stale.since}, and the changes are not committed: ${named(uncommitted)}. Commit or discard them in the development copy, then try again.`,
    );
  const taken = takenPaths(current.files),
    collided = absent.filter(file => newPathProblem(file, taken));
  if (collided.length)
    throw outdatedError(
      `${collided[0]} now exists or collides with an existing path, so it cannot be created. ${stale.action}`,
      collided,
    );
  const ignored = line.ignored(absent);
  if (ignored.length)
    throw new Error(`git ignores ${ignored.join(', ')}, so a story cannot create it. Choose another path.`);
  const allowedFiles = [...files.filter(file => !gone.includes(file)), ...created];
  for (const file of allowedFiles) {
    const bytes = line.read(file);
    if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))
      throw new Error('Approved source files must be UTF-8 text.');
  }
  return {
    allowedFiles,
    newFiles: absent,
    deleteFiles: deleteFiles.filter(file => !gone.includes(file)),
    ...(gone.length ? { deletedSince: gone } : {}),
  };
}

// The paths a story may change: the director's latest edit (editSourceStory) when there is one,
// otherwise the paths its breakdown story or review proposal listed.
const storyPaths = (task, proposed) => scopePaths(task.scopeEdits?.at(-1) || proposed);
const implementationAttempts = (store, task) =>
  store.attempts(task.id).filter(attempt => (attempt.assignment?.kind || task.kind) === 'studio-development:change');
// Whether a story has work to keep: an earlier implementation attempt, or a change to merge onto the current source.
const hasEarlierWork = (store, task) => !!task.sourceStage?.merge || implementationAttempts(store, task).length > 0;
// The work a story continues from: the latest stopped implementation attempt of this story (never
// a candidate review, never an older attempt in place of a newer one), read from its verified
// checkpoint or, for attempts from before checkpoints, its registered source files. Its work is
// each file whose bytes differ from that attempt's baseline. Paths no longer approved are skipped
// and named. When its work cannot be verified, or the source of a path it changed was committed
// since that attempt, the whole work starts fresh from the current source with the reason (fresh);
// the earlier attempt and its history stay. A commit to a path it did not change carries the work.
// A director's edit with keepWork false is a recorded fresh start for the next attempt.
function continuedWork(store, task, paths, current) {
  const implementations = implementationAttempts(store, task),
    previous = implementations.at(-1);
  if (!previous) return null;
  if (
    ['running', 'stopping'].includes(previous.status) ||
    (['interrupted', 'quarantined'].includes(previous.status) && !previous.reconciledAt)
  )
    throw new Error(`Attempt ${previous.id} has not stopped and been reconciled; its work cannot be continued yet.`);
  const fresh = (reason, changed = []) => ({
    attemptId: previous.id,
    files: [],
    skipped: [],
    fresh: { reason, ...(changed.length ? { paths: changed } : {}) },
  });
  const edit = task.scopeEdits?.at(-1);
  if (
    edit &&
    !implementations.some(attempt => attempt.startedAt >= edit.at) &&
    // Edits saved before keepWork was recorded carried work only through sourceStage.continueFrom.
    (edit.keepWork === false || (edit.keepWork === undefined && !task.sourceStage?.continueFrom))
  )
    return fresh(`the director's edit of ${edit.at} did not keep the earlier work`);
  const scope = previous.sourceChange;
  if (!scope?.source?.files) return null;
  const manifest = readContinuation(store, previous);
  if (manifest.status !== 'complete')
    return fresh(
      `its recorded work could not be verified (${(manifest.issues || []).join(' ').slice(0, 500) || manifest.status})`,
    );
  const writable = [...paths.allowedFiles, ...paths.newFiles],
    before = file => scope.source.files.find(entry => entry.path === file)?.hash ?? null,
    now = file => current.files.find(entry => entry.path === file)?.hash ?? null,
    files = [],
    skipped = [],
    setAside = [];
  for (const item of manifest.files) {
    const file = item.path.slice('changes/'.length);
    if (!item.path.startsWith('changes/') || item.hash === before(file)) continue;
    if (writable.includes(file)) files.push({ path: file, hash: item.hash });
    else if (paths.deletedSince?.includes(file)) setAside.push({ path: file, hash: item.hash });
    else skipped.push({ path: file, reason: 'no longer in the approved files' });
  }
  const deleted = scope.deleteFiles || [];
  for (const file of deleted)
    if (!paths.deleteFiles.includes(file)) skipped.push({ path: file, reason: 'no longer approved for deletion' });
  const conflicts = [
    ...files.map(item => item.path),
    ...deleted.filter(file => paths.deleteFiles.includes(file)),
  ].filter(file => before(file) !== now(file));
  // Work whose source was committed since is merged onto the current source by git when the attempt is prepared,
  // as a change merged onto the current source is, rather than dropped (October 27): `changed` names those files.
  // It needs that attempt's base commit, which a rewritten history may have lost.
  let based = false;
  if (conflicts.length && files.length && scope.base?.commit)
    try {
      git(current.root, ['cat-file', '-e', `${scope.base.commit}^{commit}`]);
      based = true;
    } catch {}
  const kept = setAside.length ? { setAside } : {};
  if (based)
    return { attemptId: previous.id, files, skipped, ...kept, merge: { base: scope.base.commit, changed: conflicts } };
  if (conflicts.length) return fresh('the source of files it changed was committed since that attempt', conflicts);
  return files.length || skipped.length || setAside.length ? { attemptId: previous.id, files, skipped, ...kept } : null;
}
// Why an attempt starts from the current source although earlier work was recorded.
export const freshStartText = carried =>
  carried?.fresh
    ? `This attempt starts from the current source instead of the work of ${carried.attemptId}: ${carried.fresh.reason}${carried.fresh.paths ? ` (${carried.fresh.paths.join(', ')})` : ''}. Its history still shows that work.`
    : '';
// What every scope carries besides its paths: the director's edits and the work it continues from, or the earlier
// change to merge onto the current source (1.1 step 3).
function storyScopeExtras(store, task, paths, current) {
  const merge = pendingMerge(store, task, paths),
    continueFrom = merge ? null : continuedWork(store, task, paths, current);
  return {
    ...(task.scopeEdits?.length ? { scopeEdits: structuredClone(task.scopeEdits) } : {}),
    ...(continueFrom ? { continueFrom } : {}),
    ...(merge ? { merge } : {}),
  };
}
// A story sent back to merge its change onto the current source, until its next implementation attempt starts: the
// candidate commit git applies to the new base, the files it changed that the story may still write, and the files
// that conflicted when it was integrated.
function pendingMerge(store, task, paths) {
  const merge = task.sourceStage?.merge;
  if (!merge || implementationAttempts(store, task).some(attempt => attempt.startedAt >= merge.at)) return null;
  const writable = [...paths.allowedFiles, ...paths.newFiles];
  return {
    from: merge.candidateAttemptId,
    candidateCommit: merge.candidateCommit,
    files: merge.files.filter(file => writable.includes(file)),
    conflicts: [...merge.conflicts],
  };
}
// Which of source-scope.json's situational entries a story's next attempt can have, so its instructions explain only
// those: directorEdits and merge exactly as storyScopeExtras sets them, and continueFrom whenever an earlier attempt
// exists, since only that attempt's recorded files decide whether its work carries on.
export function storySituation(store, task) {
  const merge = task.sourceStage?.merge,
    attempts = implementationAttempts(store, task),
    merging = !!merge && !attempts.some(attempt => attempt.startedAt >= merge.at);
  return { directorEdits: !!task.scopeEdits?.length, continueFrom: !merging && attempts.length > 0, merge: merging };
}
// What a candidate's review needs explained: a candidate from before diffs or source-scope.json (legacy), and paths
// the editor asked for that were then added (MP-021), which the review judges.
export function candidateSituation(store, task) {
  const ref = task.sourceStage
      ? sourceCandidateReference(store, task)
      : acceptedReference(store, task.dependencies[0], undefined, recordProject(task)),
    candidate = store.attempt(ref.attemptId),
    has = name => candidate.artifacts.some(item => item.path === name);
  return {
    legacy: !has('change.diff') || !has('source-scope.json'),
    requested: !!candidate.sourceChange?.scopeEdits?.some(edit => edit.request),
  };
}
// The work that landed since a change was tested (landedSince), named as a story's page names it: its stories, then
// any commits made by hand.
function landedText(store, landed) {
  const named = landed.stories.map(({ storyId }) => {
      let title = null;
      try {
        title = store.task(storyId).title;
      } catch {}
      return title ? `${storyId} (“${title}”)` : storyId;
    }),
    byHand = landed.commits - landed.stories.length;
  if (byHand > 0) named.push(`${byHand} ${byHand === 1 ? 'commit' : 'commits'} made by hand`);
  return named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
}
// Sends a story back to its editor with its change merged onto the current source (1.1 step 3, the director, October
// 25: "keep the code that was already built and just have the agent merge it together"): one whose integration stopped
// on a conflict, or, since October 27, one that passed its own tests and failed them merged onto work that landed
// since it was tested. Git applies the reviewed candidate to the line's tip, as integration does; the editor resolves
// the parts git could not combine, or makes the change work with what landed. Its tests and a fresh independent review
// follow. `by` is the director or the policy.
export function mergeSourceStory(store, registries, task, by = { type: 'director' }) {
  return store.tx(() => {
    const story = store.task(task.id),
      stage = story.sourceStage,
      review = stage?.review && store.attempt(stage.review.attemptId),
      journal = review?.sourceIntegration,
      conflicts = journal?.verification?.conflicts || [],
      landed = journal?.verification?.landedSince;
    if (
      story.kind !== 'studio-development:change' ||
      story.status !== 'done' ||
      stage.current !== 'failed' ||
      stage.phase !== 'integration' ||
      journal?.state !== 'rejected' ||
      !(conflicts.length || landed)
    )
      throw new Error(
        'Only a story whose integration stopped on a conflict, or failed its tests merged onto work that landed since, can be merged onto the current source.',
      );
    const named = conflicts.join(', '),
      tests = (journal.verification.failedTests || []).slice(0, 10).map(item => item.name),
      failing = tests.length
        ? `these tests fail: ${tests.join('; ')}`
        : /^The build failed/.test(journal.error || '')
          ? 'the build fails'
          : 'its tests fail';
    registries.workflows.stagesOf(story).retry(story);
    stage.merge = {
      candidateAttemptId: journal.candidateAttemptId,
      candidateCommit: journal.candidateCommit,
      files: journal.changes.filter(item => item.afterHash !== null).map(item => item.path),
      conflicts: [...conflicts],
      ...(conflicts.length ? {} : { landed: landed.stories.map(item => item.storyId), failedTests: tests }),
      at: new Date().toISOString(),
      by,
    };
    stage.merges = (stage.merges || 0) + 1;
    story.direction = conflicts.length
      ? `The independent review passed your change, but work integrated since it started conflicts with it in ${named}. The controller merged your change onto the current source: the files under changes/ hold it, and ${named} hold conflict markers between the current source (<<<<<<<) and your change (>>>>>>>). Resolve each conflict so that both changes work, remove every marker, and keep the rest of your change. Its tests and an independent review follow.`
      : `The independent review passed your change, and it passed its own tests, but ${landedText(store, landed)} landed since it started, and merged onto that, ${failing}. The controller merged your change onto the current source, with no conflicts: the files under changes/ hold it. Make your change work with what landed so the tests pass, without undoing any of what landed, and keep the rest of your change. Its tests and an independent review follow.`;
    delete story.autonomyNote;
    Object.assign(story, { status: 'ready', queued: false, reason: '', controllerWait: false });
    registries.workflows.stageProgress(store, story);
    store.putTask(story);
    store.event(
      'source_merged',
      story.id,
      review.id,
      `${by.type === 'policy' ? `Autonomy policy revision ${by.revision}` : 'The director'} sent this story back to merge its change onto the current source and ${
        conflicts.length ? `resolve the conflicts in ${named}` : `make it work with ${landedText(store, landed)}`
      }.`,
    );
    return { ok: true, direction: story.direction };
  });
}
function breakdownChangeScope(store, task, root, dryRun, extras) {
  const reference = task.proposalReference,
    ref = acceptedReference(store, reference.taskId, reference.attemptId, recordProject(task)),
    attempt = store.attempt(ref.attemptId),
    proposalReference = { ...identity(ref, 'source-breakdown.json'), key: reference.key };
  if (
    attempt.assignment?.kind !== 'studio-development:breakdown' ||
    task.key !== reference.key ||
    typeof reference.key !== 'string' ||
    !Object.entries(proposalReference).every(([key, value]) => reference[key] === value)
  )
    throw new Error('Source story no longer matches its accepted breakdown identity.');
  const {
      report,
      source: evidence,
      checkedReference,
    } = breakdownEvidence(store, attempt, recordProject(task), reference.key, story => storyPaths(task, story), {
      earlier: hasEarlierWork(store, task),
    }),
    story = report.stories.find(story => story.key === reference.key);
  if (!story) throw new Error('The exact proposalReference.key is missing from the accepted breakdown.');
  const pinned = task.acceptedInputs || [];
  for (const required of [ref, checkedReference])
    if (
      !pinned.some(
        item =>
          item.taskId === required.taskId &&
          item.attemptId === required.attemptId &&
          equal(item.artifacts, required.artifacts),
      )
    )
      throw new Error('Source stories must pin the exact accepted breakdown and measured check inputs.');
  const siblings = story.dependencies.map(key => {
    const matches = store
      .tasks()
      .filter(
        sibling =>
          sibling.proposalReference?.taskId === reference.taskId &&
          sibling.proposalReference.attemptId === reference.attemptId &&
          sibling.proposalReference.path === reference.path &&
          sibling.proposalReference.hash === reference.hash &&
          sibling.proposalReference.key === key &&
          recordProject(sibling) === recordProject(task),
      );
    if (matches.length !== 1) throw new Error(`Missing exact sibling prerequisite ${key}.`);
    return matches[0].id;
  });
  const expected = [reference.taskId, evidence.taskId, ...siblings];
  if (
    task.dependencies.length !== expected.length ||
    expected.some(id => !task.dependencies.includes(id)) ||
    pinned.some(item => !expected.includes(item.taskId))
  )
    throw new Error('Source story prerequisites no longer match its recorded sibling graph.');
  // Prerequisite acceptance supplies artifacts, not proof of live integration.
  // Scope is always selected from this story alone.
  const siblingInputs = siblings.map(id => {
    const sibling = store.task(id);
    if (sibling.status !== 'done' || !sibling.acceptedAttemptId)
      throw new Error(`Sibling prerequisite ${id} must have an exact accepted attempt before this story can run.`);
    return acceptedReference(store, id, sibling.acceptedAttemptId, recordProject(task));
  });
  // The story is measured with the profile its idea's checks used.
  const profile = profileOf(evidence),
    checkedSource = store.attempt(evidence.attemptId).sourceCheck,
    { line, current, files } = storySource(store, recordProject(task), root, checkedSource, profile, task);
  if (current.root !== checkedSource.root)
    throw new Error('The controller source target changed. Request fresh measured evidence and a new breakdown.');
  const paths = verifyStoryScope(storyPaths(task, story), current, evidence.files, {
    integrated: integratedSourceChanges(store, current.root),
    created: integratedChanges(store, siblings),
    files,
    earlier: hasEarlierWork(store, task),
  });
  return {
    connector: sourceChangesConnector,
    proposalReference,
    reviewedSourceHash: evidence.sourceHash,
    proposal: structuredClone(story),
    source: current,
    ...(dryRun ? {} : { base: passBase(root, line, profile) }),
    ...paths,
    acceptedInputs: [ref, checkedReference, ...siblingInputs],
    ...(extras ? storyScopeExtras(store, task, paths, current) : {}),
  };
}
// A story reaches the integrated milestone once its reviewed candidate is committed.
export function sourceStoryIntegrated(task) {
  return task.sourceStage?.current === 'integrated' || task.sourceStage?.integration?.state === 'integrated';
}
// The files integrations into this source committed, by path, with the hashes they left. Every
// integrated story counts, whichever breakdown, review or project it came from.
function integratedSourceChanges(store, root) {
  const files = new Map();
  for (const { sourceIntegration: journal } of store.integrationJournals('integrated')) {
    if (journal.root === root)
      for (const change of journal.changes || [])
        files.set(change.path, (files.get(change.path) || new Set()).add(change.integratedHash || change.afterHash));
  }
  return files;
}
// The files integrated prerequisite stories committed, by path, with the hashes they left,
// following each prerequisite's own prerequisite stories.
function integratedChanges(store, storyIds, seen = new Set(), files = new Map()) {
  for (const id of storyIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const story = store.task(id);
    if (story.kind !== 'studio-development:change') continue;
    const reviewId = story.sourceStage?.integration?.attemptId || story.sourceStage?.review?.attemptId,
      journal = reviewId && store.attempt(reviewId)?.sourceIntegration;
    if (sourceStoryIntegrated(story) && journal?.state === 'integrated')
      for (const change of journal.changes || [])
        files.set(change.path, (files.get(change.path) || new Set()).add(change.integratedHash || change.afterHash));
    integratedChanges(store, story.dependencies, seen, files);
  }
  return files;
}
// A story holds a place on its line only while its agent builds it, the candidate's own tests included: waiting for
// its review, being reviewed, waiting to merge and merging hold none, and a story sent back holds one again when it is
// built again (the director, October 29: "I do think stories should only hold their spot when it's neccessary"). A
// line has as many places as the studio runs attempts at once (Attempts at the same time), so one setting says how
// many build at once. A project with release lines (1.1 step 1) counts each line separately. Before October 29 a
// story held one of two places from its first edit until it was integrated (1.1 step 3). Each candidate is retested
// merged onto the current source before it lands, and a conflict is merged onto it (mergeSourceStory).
export const storiesPerLine = store => Math.max(1, store.organization().maxParallel || 1);
// The other stories building on this story's line.
export function sourceStoriesInFlight(store, task) {
  const line = storyLine(store, task);
  return store.tasks().filter(other => {
    if (
      other.id === task.id ||
      other.kind !== 'studio-development:change' ||
      recordProject(other) !== recordProject(task) ||
      ['denied', 'cancelled', 'failed', 'backlog'].includes(other.status) ||
      sourceStoryIntegrated(other) ||
      (line !== undefined && storyLine(store, other) !== line)
    )
      return false;
    // Its agent builds it now, a story from before stages included.
    return (
      ['running', 'stopping'].includes(other.status) && (other.sourceStage?.phase ?? 'implementing') === 'implementing'
    );
  });
}
// The first story this one waits for when its line is full, or undefined when it may start.
export function sourceStoryInFlight(store, task) {
  const holders = sourceStoriesInFlight(store, task);
  return holders.length >= storiesPerLine(store) ? holders[0] : undefined;
}
// An accepted story that is not integrated may be closed without integrating it, which lets
// go of the source for the next story; its candidate and review stay recorded. A recorded
// integration must be reconciled first.
export function sourceStoryClosable(store, task) {
  if (task.kind !== 'studio-development:change' || !task.sourceStage || sourceStoryIntegrated(task)) return false;
  const reviewId = task.sourceStage.review?.attemptId,
    journal = reviewId && store.attempt(reviewId)?.sourceIntegration;
  if (journal && !['rejected', 'abandoned'].includes(journal.state))
    throw new Error('Reconcile the recorded source integration before closing this story.');
  return true;
}
export function sourceStoryClosed(task, reason) {
  if (task.kind !== 'studio-development:change' || !task.sourceStage) return;
  Object.assign(task.sourceStage, { current: 'closed', reason });
}
// The story's accepted breakdown story or review proposal, as it was accepted.
export function proposedStory(store, task) {
  const reference = task.proposalReference,
    attempt = store.attempt(reference.attemptId),
    bytes = fs.readFileSync(artifactPath(store, attempt, reference.path));
  if (hash(bytes) !== reference.hash) throw new Error('The accepted proposal changed after it was accepted.');
  const report = JSON.parse(bytes);
  return reference.path === 'source-breakdown.json'
    ? report.stories.find(story => story.key === reference.key)
    : report.proposal;
}
// The paths the story's accepted breakdown story or review proposal listed.
const proposedPaths = (store, task) => scopePaths(proposedStory(store, task));
const pathLists = ['files', 'newFiles', 'deleteFiles'],
  pathLabels = { files: 'Files', newFiles: 'New files', deleteFiles: 'Delete' },
  maxScopeEdits = 20;
// The rules an edit of a story's paths meets, whoever sends it: the director's edit and the policy's approval of a file
// request (editSourceStory), and the check of a blocked editor's file request as Allow and continue would send it
// (checkScopeRequest). The edit gives a reason, names its paths as lists that change the story's, and stays within the
// story's edit count. Returns its paths and those it replaces.
function editPaths(store, task, edit) {
  boundedText(edit.reason, 2000, 'The reason for the edit');
  if (edit.note !== undefined && (typeof edit.note !== 'string' || edit.note.length > 4000))
    throw new Error('The note for the next attempt must be bounded text.');
  if (edit.keepWork !== undefined && typeof edit.keepWork !== 'boolean')
    throw new Error('keepWork must be true or false.');
  const paths = scopePaths({
      files: edit.files,
      newFiles: edit.newFiles ?? [],
      deleteFiles: edit.deleteFiles ?? [],
    }),
    previous = storyPaths(task, proposedPaths(store, task)),
    sorted = list => [...list].sort();
  if (!pathLists.every(list => Array.isArray(paths[list]) && paths[list].every(file => typeof file === 'string')))
    throw new Error('A story edit lists files, newFiles and deleteFiles as arrays of source paths.');
  if (pathLists.every(list => equal(sorted(paths[list]), sorted(previous[list]))))
    throw new Error("The edit does not change the story's files.");
  if ((task.scopeEdits?.length || 0) >= maxScopeEdits)
    throw new Error(`A story keeps at most ${maxScopeEdits} edits; close it and plan the work again.`);
  return { paths, previous };
}
// Every rule a dispatch applies to the story as an edit would leave it (edited), except the clean development copy a
// start needs, and with extras false the earlier work its next attempt continues from, which an attempt still running
// cannot be judged by. Nothing is written but, when the source moved past the story's plan, its out-of-date note.
function checkEditedScope(store, edited, root, { extras = true } = {}) {
  try {
    return changeScope(store, edited, root, { dryRun: true, extras });
  } catch (error) {
    recordOutdated(store, edited.id, error);
    throw error;
  }
}
// The director edits a stopped story's approved paths and sends it back to implementation,
// keeping the work its last attempt staged (the director's direction, October 20, 2026). The
// paths follow the same rules and drift checks as at dispatch, and each edit is recorded with its
// reason and the paths it replaced. A story can be edited while its implementation is stopped
// (blocked, failed, cancelled, waiting or awaiting acceptance) or after its review requested changes.
// An edit that approves the file request of the story's latest attempt (scopeRequest) names that
// attempt as request, and the edit records it. by is the director, or the autonomy policy when it
// approves a request (approveScopeRequest).
export function editSourceStory(store, task, edit, root, { by = { type: 'director' } } = {}) {
  closedFields(edit, [...pathLists, 'reason', 'keepWork', 'note', 'request'], 'A story edit');
  if (task.kind !== 'studio-development:change' || task.approval?.status !== 'approved' || !task.proposalReference)
    throw new Error('Only an approved source story can be edited.');
  if (task.closed || task.status === 'denied' || sourceStoryIntegrated(task))
    throw new Error('This story is closed or integrated; it can no longer be edited.');
  // Only a review that requested changes opens the story to an edit; a passed one goes back through Send back.
  const returned = sourceStoryReturnable(store, task),
    findings = returned && !returned.passed ? returned.findings : '',
    reviewId = task.sourceStage?.review?.attemptId,
    journal = reviewId && store.attempt(reviewId)?.sourceIntegration;
  if (journal && !['rejected', 'abandoned'].includes(journal.state))
    throw new Error('An integration of this story is recorded; reconcile it before editing the story.');
  if (
    !findings &&
    (task.sourceStage?.phase === 'candidate-review' ||
      !['ready', 'blocked', 'failed', 'cancelled', 'review'].includes(task.status))
  )
    throw new Error(
      'Edit a story while its implementation is stopped, or after its independent review requested changes.',
    );
  const { paths, previous } = editPaths(store, task, edit),
    at = new Date().toISOString(),
    implementations = implementationAttempts(store, task),
    // The latest attempt that recorded staged work; a cancelled attempt records none.
    worked = [...implementations]
      .reverse()
      .find(attempt =>
        attempt.artifacts?.some(item => item.kind === 'source-file' && item.path.startsWith('changes/')),
      ),
    requested = edit.request === undefined ? null : implementations.at(-1),
    edited = structuredClone(task);
  if (
    requested !== null &&
    (requested?.id !== edit.request || requested.status !== 'blocked' || !requested.scopeRequest?.reason)
  )
    throw new Error(
      "Only the file request of the story's latest attempt can be approved, while that attempt is stopped as blocked.",
    );
  edited.scopeEdits = [
    ...(task.scopeEdits || []),
    {
      ...paths,
      reason: edit.reason.trim(),
      at,
      by,
      previous,
      // keepWork false is the director's recorded fresh start for the next attempt (continuedWork).
      keepWork: edit.keepWork !== false,
      ...(requested ? { request: { attemptId: requested.id, workerId: requested.workerId } } : {}),
    },
  ];
  edited.sourceStage ||= newSourceStage();
  if (findings) sourceStageRetry(edited);
  if (edit.keepWork !== false && implementations.length)
    edited.sourceStage.continueFrom = {
      attemptId: implementations.at(-1).id,
      afterAttemptId: implementations.at(-1).id,
      at,
    };
  else delete edited.sourceStage.continueFrom;
  // Every rule a dispatch applies, except the clean development copy a start needs.
  const scope = checkEditedScope(store, edited, root),
    reported = worked || implementations.at(-1),
    changed = pathLists
      .map(list => {
        const added = paths[list].filter(file => !previous[list].includes(file)),
          removed = previous[list].filter(file => !paths[list].includes(file));
        return [
          added.length ? `${pathLabels[list]} added: ${added.join(', ')}.` : '',
          removed.length ? `${pathLabels[list]} removed: ${removed.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' ');
      })
      .filter(Boolean)
      .join(' '),
    failing = (reported?.failedTests || [])
      .map(test => `- ${test.name}${test.file ? ` (${test.file})` : ''}${test.error ? `: ${test.error}` : ''}`)
      .join('\n'),
    carried = scope.continueFrom,
    policy = by.type === 'policy',
    direction = [
      policy
        ? `The autonomy policy approved the file request of ${requested.id} for the director, adding the paths it named: ${edit.reason.trim()}`
        : `The director changed this story's files${requested ? `, answering the file request of ${requested.id}` : ''}: ${edit.reason.trim()}`,
      changed,
      `The approved paths are now:\n${scopeFilesText(paths)}`,
      findings,
      reported?.result
        ? `Previous attempt ${reported.id} (${reported.status}): ${reported.result.summary}${reported.result.issues?.length ? `\nIssues: ${reported.result.issues.join(' ')}` : ''}${failing ? `\nFailing tests:\n${failing}` : ''}`
        : '',
      carried?.files.length
        ? `Your edits from ${carried.attemptId} to ${carried.files.map(item => item.path).join(', ')} are already in changes/ (continueFrom in source-scope.json): continue from them.${
            carried.merge
              ? ` ${carried.merge.changed.join(', ')} changed on the source since, so git merged your edits onto the current source; resolve any part it marked and remove every marker.`
              : ''
          } The controller includes them in the candidate even if you do not return them; to drop one, restore the file to its ../source content.`
        : '',
      carried?.skipped.length
        ? `Not carried over: ${carried.skipped.map(item => `${item.path} (${item.reason})`).join('; ')}.`
        : '',
      carried?.setAside?.length
        ? `Set aside: your edits to ${carried.setAside.map(item => item.path).join(', ')}, which the source deleted since, are under merge-set-aside/ for reference (merge-set-aside.json).`
        : '',
      freshStartText(carried),
      edit.note?.trim() ? `Director's note: ${edit.note.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  edited.direction = direction.length > 24000 ? direction.slice(0, 23999) + '…' : direction;
  delete edited.autonomyNote;
  Object.assign(edited, { status: 'ready', queued: false, reason: '', controllerWait: false });
  sourceStageProgress(edited, store);
  store.tx(() => {
    // An implementation attempt awaiting acceptance gives way to the edited story.
    if (task.status === 'review') {
      const pending = store.attempt(task.lastAttemptId);
      pending.status = 'revision_requested';
      pending.revisionRequestedBy = { type: 'director', at, reason: edit.reason.trim().slice(0, 2000) };
      store.updateAttempt(pending);
    }
    store.putTask(edited);
  });
  store.event(
    'story_edited',
    task.id,
    worked?.id || null,
    `${policy ? `Autonomy policy revision ${by.revision} approved the file request of ${requested.id}` : `Director changed the story's files${requested ? `, approving the file request of ${requested.id}` : ''}`}: ${edit.reason.trim()} ${changed}${carried?.files.length ? ` The next attempt continues from ${carried.attemptId}.` : ''}`.trim(),
  );
  return { ok: true, direction: edited.direction, paths, continueFrom: carried || null };
}
// The autonomy policy approves a blocked editor's file request for the director (MP-021, the
// director's amendment of October 20): the story's paths plus the requested files to edit and
// create, with the editor's reason and its staged work kept, under every rule of the director's
// edit. The independent candidate review is told which paths were added. Requested deletions stay
// with the director, since approving a story is what approves its deletions. A requested file to
// edit that an earlier story in the chain created is listed as a file the story creates, as the
// director would list it (createdInChain). Returns nothing when an edit already followed the request.
export function approveScopeRequest(store, task, attempt, root, by) {
  const request = attempt.scopeRequest;
  if (task.scopeEdits?.some(edit => edit.at >= attempt.finishedAt)) return null;
  if (request.deleteFiles.length)
    throw new Error(
      `The editor asked to delete ${named(request.deleteFiles)}; deletions stay with the director. Approve or change the requested files in the story.`,
    );
  const current = storyPaths(task, proposedPaths(store, task));
  try {
    // One measurement of the source for the files the chain created and the edit's checks.
    return measuringPass(() => {
      const created = createdInChain(store, task, root, request.files);
      return editSourceStory(
        store,
        task,
        {
          files: [...current.files, ...request.files.filter(file => !created.includes(file))],
          newFiles: [...current.newFiles, ...request.newFiles, ...created],
          deleteFiles: current.deleteFiles,
          reason: request.reason,
          request: attempt.id,
        },
        root,
        { by },
      );
    });
  } catch (error) {
    throw new Error(`The requested files could not be approved automatically: ${error.message}`);
  }
}
// Of files, those the measured source a breakdown story was planned from never had, but that an integrated prerequisite
// story in its chain created and the current source holds as that story left them: the new files verifyStoryScope accepts
// as created. The story's dependencies besides its breakdown and checks are its sibling stories (breakdownChangeScope).
// A review proposal's story has no chain.
function createdInChain(store, task, root, files) {
  const evidence =
      task.proposalReference.path === 'source-breakdown.json' &&
      store.attempt(task.proposalReference.attemptId)?.sourceBreakdown,
    unmeasured = evidence ? files.filter(file => !evidence.files.some(item => item.path === file)) : [];
  if (!unmeasured.length) return [];
  const { current } = storySource(
      store,
      recordProject(task),
      root,
      store.attempt(evidence.attemptId).sourceCheck,
      profileOf(evidence),
      task,
    ),
    created = integratedChanges(store, task.dependencies);
  return unmeasured.filter(file => createdByChain(file, current, created));
}
// A blocked editor's file request (scopeRequest), checked before it is recorded as the edit Allow and continue would
// send: the story's paths plus the requested ones, with a requested file to edit that an earlier story in the chain
// created listed as one to create (createdInChain), and the request records its paths that way, so the edit offered is
// the edit checked. Every rule of editSourceStory's edit applies but the story's own state, since its attempt is still
// running; nothing is written but the story's out-of-date note when the source moved past its plan. When the edit
// would be refused, the request keeps its paths and reason and records the refusal as its problem.
export function checkScopeRequest(store, task, request, root) {
  if (!request || request.problem) return request;
  return measuringPass(() => {
    let checked = request;
    try {
      const created = createdInChain(store, task, root, request.files);
      if (created.length)
        checked = {
          ...request,
          files: request.files.filter(file => !created.includes(file)),
          newFiles: [...request.newFiles, ...created],
        };
      const current = storyPaths(task, proposedPaths(store, task)),
        join = list => [...new Set([...current[list], ...checked[list]])],
        { paths, previous } = editPaths(store, task, {
          files: join('files'),
          newFiles: join('newFiles'),
          deleteFiles: join('deleteFiles'),
          reason: checked.reason,
        }),
        edited = structuredClone(task);
      edited.scopeEdits = [
        ...(task.scopeEdits || []),
        { ...paths, reason: checked.reason, at: new Date().toISOString(), by: { type: 'director' }, previous },
      ];
      checkEditedScope(store, edited, root, { extras: false });
      return checked;
    } catch (error) {
      return { ...checked, problem: error.message };
    }
  });
}
// The scope a story's next implementation attempt receives. A dry run checks it without fixing
// the base commit, which needs a clean development copy only when the attempt starts; with extras false it leaves out
// the director's edits and the earlier work the attempt would continue from (checkEditedScope).
export function changeScope(store, task, root, { dryRun = false, extras = true } = {}) {
  if (task.approval?.status !== 'approved' || !task.proposalReference)
    throw new Error('Source editing requires approved work from one exact accepted source review.');
  validateAcceptedReferences(store, task.acceptedInputs, recordProject(task));
  if (task.proposalReference.path === 'source-breakdown.json')
    return breakdownChangeScope(store, task, root, dryRun, extras);
  if (task.dependencies.length !== 1)
    throw new Error('Source editing requires approved work from one exact accepted source review.');
  const ref = acceptedReference(store, task.dependencies[0], undefined, recordProject(task)),
    review = store.attempt(ref.attemptId);
  const proposalReference = identity(ref, 'source-review.json');
  if (
    review.assignment.kind !== 'studio-development:review' ||
    !Object.entries(proposalReference).every(([key, value]) => task.proposalReference[key] === value)
  )
    throw new Error('Source work no longer matches its accepted proposal.');
  const report = JSON.parse(fs.readFileSync(artifactPath(store, review, proposalReference.path))),
    proposal = report.proposal;
  const checked =
    review.sourceReview?.attemptId &&
    store.attempts(review.sourceReview.taskId).find(attempt => attempt.id === review.sourceReview.attemptId);
  if (
    !checked?.sourceCheck ||
    checked.assignment?.kind !== 'studio-development:checks' ||
    checked.checkExecution?.fixture !== false
  )
    throw new Error('Exact measured source-check evidence is missing. Request fresh evidence.');
  const checkedReference = acceptedReference(store, checked.taskId, checked.id, recordProject(task)),
    checkedIdentity = identity(checkedReference, 'check-report.json');
  if (
    !Object.entries(checkedIdentity).every(
      ([key, value]) => report.source?.[key] === value && review.sourceReview[key] === value,
    ) ||
    report.source.sourceHash !== checked.sourceCheck.sourceHash
  )
    throw new Error('Proposal no longer links the exact measured source identity.');
  // A dispatched employee cannot replace its guidance or executable entry configuration, and
  // changes only the proposal's paths, each unchanged since the measured checks but for changes
  // integrated stories committed.
  const profile = profileOf(checked.sourceCheck),
    {
      line,
      current: source,
      files,
    } = storySource(store, recordProject(task), root, checked.sourceCheck, profile, task),
    paths = verifyStoryScope(
      storyPaths(task, proposal),
      source,
      checked.sourceCheck.files,
      { integrated: integratedSourceChanges(store, source.root), files, earlier: hasEarlierWork(store, task) },
      { since: 'the proposal', action: 'Request fresh evidence.' },
    );
  return {
    connector: sourceChangesConnector,
    proposalReference,
    reviewedSourceHash: checked.sourceCheck.sourceHash,
    proposal: structuredClone(proposal),
    source,
    ...(dryRun ? {} : { base: passBase(root, line, profile) }),
    ...paths,
    ...(extras ? storyScopeExtras(store, task, paths, source) : {}),
  };
}
// The approved scope the employee and the reviewer read (source-scope.json). Scopes from before
// new and deleted files have no newFiles or deleteFiles and keep their recorded document; the
// director's edits and the work an attempt continues from appear only when there are any. An edit
// that answered an editor's file request (MP-021) also names the requesting attempt, the paths it
// added and who approved it, so the independent review can judge whether the scope needed them.
export const scopeDocument = scope => ({
  proposal: scope.proposalReference,
  allowedFiles: scope.allowedFiles,
  ...(scope.newFiles ? { newFiles: scope.newFiles, deleteFiles: scope.deleteFiles } : {}),
  scope: scope.proposal,
  ...(scope.scopeEdits
    ? {
        directorEdits: scope.scopeEdits.map(edit => ({
          reason: edit.reason,
          at: edit.at,
          files: edit.files,
          newFiles: edit.newFiles,
          deleteFiles: edit.deleteFiles,
          ...(edit.request
            ? {
                requestedIn: edit.request.attemptId,
                added: pathLists.flatMap(list => edit[list].filter(file => !edit.previous[list].includes(file))),
                approvedBy: edit.by.type === 'policy' ? 'autonomy policy' : 'director',
              }
            : {}),
        })),
      }
    : {}),
  ...(scope.deletedSince ? { deletedSince: scope.deletedSince } : {}),
  ...(scope.continueFrom ? { continueFrom: scope.continueFrom } : {}),
  // A change merged onto the current source (1.1 step 3): the files it holds and those with conflict markers.
  ...(scope.merge
    ? { merge: { from: scope.merge.from, files: scope.merge.files, conflicts: scope.merge.conflicts } }
    : {}),
});
// An editor that needs paths outside the approved ones stops as blocked and names them in
// scope-request.json (MP-021). The controller records the request on the attempt when it names
// only paths the story does not have, which together with the approved ones pass the path rules
// against the snapshot the editor read, or records the problem instead. A request that passes is then checked as the
// edit approving it would be (checkScopeRequest). A request never changes the story: the director approves it by
// editing the story's files (editSourceStory).
export const scopeRequestFile = 'scope-request.json';
const maxScopeRequestBytes = 64 * 1024;
export function scopeRequest(scope, result, read) {
  const listed = result.artifacts.filter(item => item?.path === scopeRequestFile);
  if (!listed.length) return null;
  try {
    if (listed.length > 1 || listed[0].kind !== 'source-scope-request')
      throw new Error(`Return ${scopeRequestFile} once, with kind source-scope-request.`);
    let request;
    try {
      const bytes = read(scopeRequestFile);
      if (bytes.length > maxScopeRequestBytes) throw new Error();
      request = JSON.parse(bytes);
    } catch {
      throw new Error(`${scopeRequestFile} must be readable JSON of at most ${maxScopeRequestBytes / 1024} KiB.`);
    }
    closedFields(request, ['schemaVersion', ...pathLists, 'reason'], 'The file request');
    if (request.schemaVersion !== 'source-scope-request-v1')
      throw new Error('The file request must have schemaVersion source-scope-request-v1.');
    boundedText(request.reason, 2000, "The file request's reason");
    const paths = scopePaths({
      files: request.files ?? [],
      newFiles: request.newFiles ?? [],
      deleteFiles: request.deleteFiles ?? [],
    });
    if (!pathLists.every(list => Array.isArray(paths[list]) && paths[list].every(file => typeof file === 'string')))
      throw new Error('The file request lists files, newFiles and deleteFiles as arrays of source paths.');
    const approved = [...scope.allowedFiles, ...(scope.newFiles || []), ...(scope.deleteFiles || [])],
      requested = pathLists.flatMap(list => paths[list]),
      already = requested.filter(file => approved.includes(file));
    if (!requested.length) throw new Error('The file request names no path.');
    if (already.length) throw new Error(`The file request names paths the story already has: ${named(already)}.`);
    validateStoryPaths(
      {
        files: [...scope.allowedFiles, ...paths.files],
        newFiles: [...(scope.newFiles || []), ...paths.newFiles],
        deleteFiles: [...(scope.deleteFiles || []), ...paths.deleteFiles],
      },
      scope.source.files,
      'The story with the requested paths',
      profileOf(scope.source),
    );
    return { ...paths, reason: request.reason.trim() };
  } catch (error) {
    return { problem: error.message };
  }
}
export function stagedChanges(scope, result, read) {
  validateResult(result, maxScopePaths);
  // Name every problem: an automatic retry receives this message as its direction.
  const failed = result.checks.filter(check => check.status === 'fail'),
    problems = [];
  if (result.outcome !== 'completed') problems.push(`the outcome is ${result.outcome}, not completed`);
  // A story that only deletes files may return none; the controller deletes the listed files.
  if (!result.artifacts.length && !scope.deleteFiles?.length)
    problems.push('0 artifacts were returned; return each approved file you changed or created under changes/');
  for (const check of failed)
    problems.push(`your check "${check.name.slice(0, 120)}" failed: ${check.evidence.slice(0, 300)}`);
  if (problems.length)
    throw new Error(
      `Complete the bounded source change with staged source artifacts: ${problems.join('; ')}.` +
        (failed.length
          ? ' The controller runs the full test suite in its own sandbox after you stop. Report a check your environment could not run (for example local HTTP tests blocked by your sandbox), or a failure you cannot tie to your change, as not-run with what you saw, and use fail only for a defect in the change.'
          : ''),
    );
  // Edits and new files come back as staged copies; a created file has no beforeHash and a deleted
  // one no afterHash. Size is bounded per file here and by the change's diff, not by a total.
  const writable = [...scope.allowedFiles, ...(scope.newFiles || [])],
    changes = [],
    seen = new Map(),
    shown = text => JSON.stringify(text.length > 120 ? text.slice(0, 119) + '…' : text);
  for (const [index, artifact] of result.artifacts.entries()) {
    const file = artifact.path.slice('changes/'.length);
    if (artifact.path === scopeRequestFile || artifact.path === 'question.json')
      throw new Error(
        `Return ${artifact.path} only with outcome blocked; a completed change stays inside the approved paths.`,
      );
    // Name the entry as returned and its position: the adapter appends carried-over work after the
    // editor's own artifacts, so a duplicate it caused shows as a late entry.
    const broken = !artifact.path.startsWith('changes/')
      ? 'is not under changes/, so it is not a staged copy of a source file'
      : !writable.includes(file)
        ? `is not one of the story's approved or new files (${named(writable) || 'it has none'})`
        : seen.has(file)
          ? `is listed twice, as returned artifacts ${seen.get(file) + 1} and ${index + 1} of ${result.artifacts.length}`
          : artifact.kind !== 'source-file'
            ? `was returned with kind ${shown(artifact.kind)} instead of source-file`
            : '';
    if (broken)
      throw new Error(
        `Staged source edits exceed the approved file scope: the returned artifact ${shown(artifact.path)} ${broken}.`,
      );
    seen.set(file, index);
    const contents = read(artifact.path),
      { fileBytes } = measuringLimits(profileOf(scope.source));
    if (contents.length > fileBytes || contents.includes(0) || !Buffer.from(contents.toString('utf8')).equals(contents))
      throw new Error(
        `Source changes must be UTF-8 text files of at most ${fileBytes % (1024 * 1024) ? `${Math.ceil(fileBytes / 1024)} KiB` : `${fileBytes / 1024 / 1024} MiB`}.`,
      );
    const original = scope.source.files.find(item => item.path === file),
      afterHash = hash(contents);
    if (afterHash === original?.hash) throw new Error('A staged source edit contains no change.');
    changes.push({
      path: file,
      artifact: artifact.path,
      beforeHash: original?.hash ?? null,
      afterHash,
      bytes: contents.length,
    });
  }
  for (const file of scope.deleteFiles || [])
    changes.push({
      path: file,
      beforeHash: scope.source.files.find(item => item.path === file).hash,
      afterHash: null,
      bytes: 0,
    });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
// The candidate's files: the base snapshot with the changes applied, in snapshot order.
function candidateFiles(files, changes) {
  const changed = new Map(changes.map(item => [item.path, item]));
  return [
    ...files.filter(item => changed.get(item.path)?.afterHash !== null),
    ...changes.filter(item => item.beforeHash === null),
  ]
    .map(item => {
      const change = changed.get(item.path);
      return change ? { path: item.path, bytes: change.bytes, hash: change.afterHash } : item;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
export function validateSourceChange(attempt, read, result = attempt.result) {
  const manifest = JSON.parse(read('source-change.json')),
    scope = attempt.sourceChange,
    completeDeletions = Object.hasOwn(manifest, 'diffFormat');
  const originalResult = {
    ...result,
    outcome: 'completed',
    artifacts:
      manifest.changes?.filter(item => item.artifact).map(item => ({ path: item.artifact, kind: 'source-file' })) || [],
    checks: [],
  };
  const changes = stagedChanges(scope, originalResult, read);
  const expectedFiles = candidateFiles(scope.source.files, changes);
  const candidate = attempt.sourceCandidate;
  // The tests ran where the attempt recorded: through the built-in sandbox's runner or, by the director's
  // choice, as the plain test command. A candidate tested before 1.0.1 may have run in the Codex sandbox
  // command, which its review still accepts.
  // The runner is named by its file, so a record stays valid when the controller's copy moves.
  const first = candidate.command.args[0],
    sandbox = testSandboxOf(attempt.configuration),
    codex = sandbox === 'codex' && equal(candidate.sandbox, codexSandboxRecord(attempt.configuration));
  if (
    codex
      ? first !== 'sandbox'
      : !equal(candidate.sandbox, sandboxRecord(attempt.configuration)) ||
        (sandbox === 'none' ? first !== '--test' : path.basename(first) !== path.basename(builtInSandboxRunner))
  )
    throw new Error('Candidate tests require the recorded source sandbox.');
  // A project whose settings name a build ran it before the tests, wrapped as they were (1.1).
  if (
    !!profileOf(scope.source).build !== !!candidate.build ||
    (candidate.build &&
      sandbox !== 'none' &&
      (candidate.build.executable !== candidate.command.executable ||
        candidate.build.args[0] !== candidate.command.args[0]))
  )
    throw new Error("The candidate's build does not match its repository settings and test sandbox.");
  if (
    !equal(manifest, {
      schemaVersion: 'source-change-v1',
      proposal: scope.proposalReference,
      baseHash: scope.source.sourceHash,
      candidateHash: candidate.sourceHash,
      changes,
      ...(completeDeletions ? { diffFormat: sourceDiffFormat } : {}),
    }) ||
    !equal(candidate.files, expectedFiles) ||
    candidate.sourceHash !== hash(JSON.stringify(expectedFiles))
  )
    throw new Error('Source candidate identity or change manifest is invalid.');
  const report = JSON.parse(read('check-report.json'));
  validateCheckReport(
    report,
    candidate,
    attempt.checkExecution,
    read('test-output.txt').toString(),
    read('test-errors.txt').toString(),
    candidate.build ? { execution: attempt.buildExecution, output: read('build-output.txt').toString() } : undefined,
  );
  // Since MP-016 slice 2 the reviewer reads the change as a diff, checked by applying it in reverse
  // to the candidate's files. Earlier candidates carry full before/after copies instead.
  const diffed = attempt.artifacts.some(item => item.path === 'change.diff');
  if (completeDeletions && !diffed) throw new Error('Full-deletion candidates require change.diff.');
  if (diffed) {
    const diff = read('change.diff');
    if (diff.length > sourceDiffLimit) throw new Error('The candidate diff exceeds its limit.');
    verifySourceDiff(
      diff.toString('utf8'),
      changes,
      file => read(changes.find(item => item.path === file).artifact).toString('utf8'),
      { completeDeletions },
    );
  } else {
    const context = JSON.parse(read('change-context.json'));
    if (
      !equal(
        context.map(({ path: file, before, after }) => ({
          path: file,
          beforeHash: hash(before),
          afterHash: hash(after),
        })),
        changes.map(item => ({ path: item.path, beforeHash: item.beforeHash, afterHash: item.afterHash })),
      )
    )
      throw new Error('Source change review context does not match the recorded edits.');
  }
  const paths = [
    'source-change.json',
    'check-report.json',
    'test-output.txt',
    'test-errors.txt',
    ...(candidate.build ? ['build-output.txt'] : []),
    diffed ? 'change.diff' : 'change-context.json',
    ...changes.filter(item => item.artifact).map(item => item.artifact),
  ];
  // Earlier candidates did not register the approved scope; when registered it must be the recorded one.
  if (attempt.artifacts.some(item => item.path === 'source-scope.json')) {
    paths.push('source-scope.json');
    if (!equal(JSON.parse(read('source-scope.json')), scopeDocument(scope)))
      throw new Error('The approved source scope does not match the recorded proposal.');
  }
  // The visual check's record and its images (1.2 step 8), when the story's pages were checked: only images the record
  // names, under visual/.
  if (attempt.artifacts.some(item => item.path === 'visual-check.json')) {
    paths.push('visual-check.json');
    const record = JSON.parse(read('visual-check.json')),
      captured = attempt.artifacts.filter(item => item.kind === 'visual-capture').map(item => item.path);
    if (
      record?.schemaVersion !== 'visual-check-v1' ||
      !Array.isArray(record.images) ||
      !captured.every(
        file => /^visual\/[a-z0-9-]+\.png$/.test(file) && record.images.some(image => image?.path === file),
      )
    )
      throw new Error('The visual check record does not match its images.');
    paths.push(...captured);
  }
  if (!equal(attempt.artifacts.map(item => item.path).sort(), paths.sort()))
    throw new Error('Unexpected source change artifacts.');
  return { manifest, report };
}
// The task remains the source story. Only the execution view changes for a stage;
// attempts snapshot that view and retain their own employee, inputs and instructions.
export function sourceStageTask(task) {
  if (task.kind !== 'studio-development:change' || task.sourceStage?.phase !== 'candidate-review') return task;
  return {
    ...task,
    ...task.sourceStage.reviewTask,
    id: task.id,
    dependencies: [task.id],
    acceptedInputs: task.sourceStage.candidateInput ? [task.sourceStage.candidateInput] : [],
    // The story's execution override and tier are for the edit; the review uses its own.
    execution: {},
    tier: task.sourceStage.reviewTask.tier,
    direction: task.sourceStage.reviewDirection ?? task.direction ?? '',
  };
}
export function sourceStageAttempts(store, task) {
  const attempts = store.attempts(task.id);
  if (task.kind !== 'studio-development:change' && !task.sourceStage) return attempts;
  const execution = sourceStageTask(task);
  return attempts.filter(
    attempt =>
      (attempt.assignment?.kind || task.kind) === execution.kind &&
      (execution.kind !== 'studio-development:change-review' ||
        !task.sourceStage ||
        attempt.candidateReview?.attemptId === task.sourceStage.candidate?.attemptId),
  );
}
// With the store, a stage in Review whose recorded checks failed is shown as failed.
const newSourceStage = () => ({ version: 'source-story-stages-v1', phase: 'implementing', history: [] });
export function sourceStageProgress(task, store) {
  if (task.kind !== 'studio-development:change') return;
  // Records from before stages (with a separate review task) and finished work never gain a
  // stage when they are saved, so their history stays as it was. Accepting one starts it.
  if (
    !task.sourceStage &&
    (task.proposedTaskIds?.length || ['done', 'denied', 'cancelled', 'failed'].includes(task.status))
  )
    return;
  task.sourceStage ||= newSourceStage();
  const stage = task.sourceStage;
  if (['ready', 'running', 'stopping', 'review', 'failed', 'blocked', 'cancelled'].includes(task.status)) {
    stage.current = ['failed', 'blocked', 'cancelled'].includes(task.status)
      ? task.status === 'cancelled'
        ? 'failed'
        : task.status
      : stage.phase;
    stage.reason = task.reason || (task.status === 'cancelled' ? 'Attempt cancelled.' : '');
    if (task.status === 'ready') delete stage.attemptId;
    if (task.status === 'running') {
      stage.attemptId = task.lastAttemptId;
      if (stage.phase === 'candidate-review')
        stage.review = { taskId: task.id, attemptId: task.lastAttemptId, workerId: stage.reviewTask.workerId };
    }
  }
  if (store && task.status === 'review') {
    const attempt = store.attempt(task.lastAttemptId);
    if ([...(attempt.result?.checks || []), ...(attempt.controllerChecks || [])].some(c => c.status === 'fail'))
      Object.assign(stage, {
        current: 'failed',
        reason: 'Recorded stage checks failed; inspect the attempt evidence.',
      });
  }
}
// Records a finished review-stage attempt on its story.
export function sourceStageFinished(task, attempt) {
  if (task.kind !== 'studio-development:change' || attempt.assignment.kind !== 'studio-development:change-review')
    return;
  task.sourceStage.review = {
    taskId: task.id,
    attemptId: attempt.id,
    workerId: attempt.workerId,
    ...(attempt.artifacts[0] ? { path: attempt.artifacts[0].path, hash: attempt.artifacts[0].hash } : {}),
    ...(attempt.candidateReviewVerdict ? { verdict: attempt.candidateReviewVerdict } : {}),
  };
}
// A review that requested changes sends the story back to implementation.
export function sourceStageRetry(task) {
  if (task.kind !== 'studio-development:change' || !task.sourceStage) return false;
  task.sourceStage.phase = 'implementing';
  return true;
}
// The review stage keeps its own direction, so directing or retrying the review never rewrites
// the direction the story's next implementation attempt receives.
export function sourceStageDirection(task, text) {
  if (task.kind !== 'studio-development:change' || task.sourceStage?.phase !== 'candidate-review') return false;
  task.sourceStage.reviewDirection = text;
  return true;
}
// What the director may send back to implementation, as { findings, passed, needsNote }: the accepted
// independent review that requested changes, with its blocking findings, or a review that passed while the story is
// not integrated, its integration neither approved nor under way (one that stopped may be redone), with its summary
// and its non-blocking notes. A pass has no findings by definition (MP-019), so the director's note is needed only
// when the review noted nothing either. The next attempt also reads the whole review in its history (item 18).
// Nothing while the review has not finished.
export function sourceStoryReturnable(store, task) {
  const stage = task.sourceStage,
    review = stage?.review;
  if (
    task.kind !== 'studio-development:change' ||
    task.status !== 'done' ||
    !review ||
    task.acceptedAttemptId !== review.attemptId
  )
    return null;
  const attempt = store.attempt(review.attemptId),
    report = () => {
      const bytes = fs.readFileSync(artifactPath(store, attempt, review.path));
      if (hash(bytes) !== review.hash) throw new Error('The accepted review changed after it was accepted.');
      return JSON.parse(bytes);
    };
  if (review.verdict === 'pass') {
    const journal = attempt.sourceIntegration,
      open = stage.current === 'waiting-for-integration' && stage.phase !== 'integration',
      stopped = stage.current === 'failed' && stage.phase === 'integration',
      // A passing review whose own checks failed (November 1, 2026: a visual check that captured an error page) failed
      // the stage with no findings and nothing could move it; it goes back with the checks that failed.
      checks = stage.current === 'failed' && stage.phase === 'candidate-review',
      failed = checks
        ? [...(attempt.result?.checks || []), ...(attempt.controllerChecks || [])].filter(c => c.status === 'fail')
        : [];
    if ((!open && !stopped && !checks) || (journal && !['rejected', 'abandoned'].includes(journal.state))) return null;
    const { summary, notes = [] } = report();
    return {
      findings: [
        checks
          ? 'The independent review passed, but its checks failed, so the change goes back for another attempt.'
          : 'The independent review passed, and the director sent the change back for another attempt.',
        `- ${summary}`,
        ...failed.map(check => `- ${check.name} failed: ${check.evidence}`),
        ...(notes.length ? ['Its notes, which did not block it:', ...notes.map(note => `- ${note}`)] : []),
      ].join('\n'),
      passed: !checks,
      needsNote: !checks && !notes.length,
    };
  }
  if (review.verdict !== 'needs-work') return null;
  // The director may have integrated over the review (MP-019): while that merge is recorded and not settled as stopped,
  // the story is not sent back, so its journal and the repository it holds wait for Reconcile source integration.
  // A merge reconciled as stopped before it landed leaves the story waiting for integration; it may go back then too.
  const journal = attempt.sourceIntegration;
  if (journal && !['rejected', 'abandoned'].includes(journal.state)) return null;
  if (stage.current !== 'failed' && !(journal && stage.current === 'waiting-for-integration')) return null;
  const { summary, findings } = report();
  return {
    findings: [
      'The independent review requested changes. Address these findings:',
      `- ${summary}`,
      ...findings.map(finding => `- ${finding}`),
    ].join('\n'),
    passed: false,
    needsNote: false,
  };
}
// What the independent reviewer reads of a candidate: its diff rather than full copies of the files
// it changed (MP-016 slice 2), so a review grows with the change, not with the files it touches.
// Candidates from before diffs keep every artifact as their review input.
export function reviewedArtifacts(attempt) {
  const diffed = attempt.artifacts.some(item => item.path === 'change.diff');
  return attempt.artifacts.filter(item => !diffed || item.kind !== 'source-file');
}
// A stage can consume its earlier accepted implementation while the same story
// is active. This exception never changes general accepted-input semantics.
export function sourceCandidateReference(store, task) {
  const pinned = task.sourceStage?.candidate;
  const story = store.task(task.id),
    attempt = pinned && store.attempt(pinned.attemptId);
  if (
    !pinned ||
    story.kind !== 'studio-development:change' ||
    !equal(story.sourceStage?.candidate, pinned) ||
    attempt.taskId !== story.id ||
    attempt.status !== 'accepted' ||
    attempt.result?.outcome !== 'completed' ||
    attempt.assignment.kind !== 'studio-development:change'
  )
    throw new Error('Select the exact current accepted source candidate.');
  assertProject(store, attempt, recordProject(story));
  for (const item of attempt.artifacts)
    if (hash(fs.readFileSync(artifactPath(store, attempt, item.path))) !== item.hash)
      throw new Error('Accepted input was modified after acceptance.');
  const ref = {
    taskId: story.id,
    attemptId: attempt.id,
    summary: attempt.result.summary,
    artifacts: reviewedArtifacts(attempt).map(({ path, kind, hash }) => ({ path, kind, hash })),
  };
  if (
    identity(ref, 'source-change.json').hash !== pinned.hash ||
    attempt.sourceCandidate.sourceHash !== pinned.candidateHash
  )
    throw new Error('Accepted candidate identity changed.');
  if (task.sourceStage.candidateInput && !equal(ref, task.sourceStage.candidateInput))
    throw new Error('Pinned accepted candidate input manifest changed.');
  return ref;
}
export function advanceSourceStory(store, registries, task, attempt) {
  if (task.kind !== 'studio-development:change') return;
  task.sourceStage ||= newSourceStage();
  sourceStageProgress(task);
  const stage = task.sourceStage;
  if (attempt.assignment.kind === 'studio-development:change') {
    if (stage.candidate?.attemptId === attempt.id) return;
    if (stage.candidate) stage.history.push({ candidate: stage.candidate, review: stage.review });
    const item = attempt.artifacts.find(item => item.path === 'source-change.json');
    stage.candidate = {
      taskId: task.id,
      attemptId: attempt.id,
      path: item.path,
      hash: item.hash,
      candidateHash: attempt.sourceCandidate.sourceHash,
      workerId: attempt.workerId,
    };
    delete stage.review;
    delete stage.reviewDirection;
    delete stage.candidateInput;
    delete stage.attemptId;
    stage.phase = 'candidate-review';
    try {
      const org = projectOrganization(store, recordProject(task));
      stage.reviewTask = registries.workflows.get(task.kind).proposeWork({ org, attempt, registries }).tasks[0];
      const worker = org.workers.find(worker => worker.id === stage.reviewTask.workerId);
      Object.assign(stage.reviewTask, { team: worker.team, teamId: worker.teamId });
      store.putTask(task);
      stage.candidateInput = sourceCandidateReference(store, task);
      acceptedCandidate(store, sourceStageTask(task));
      Object.assign(task, { status: 'ready', queued: true, reason: '', controllerWait: true });
      Object.assign(stage, { current: 'candidate-review', reason: '' });
    } catch (error) {
      Object.assign(task, { status: 'blocked', queued: false, reason: error.message, controllerWait: false });
      Object.assign(stage, { current: 'blocked', reason: error.message });
    }
  } else if (attempt.assignment.kind === 'studio-development:change-review') {
    if (!equal(attempt.candidateReview, acceptedCandidate(store, attempt.assignment)))
      throw new Error('Accepted candidate identity changed.');
    const report = validateChangeReview(attempt, name => fs.readFileSync(artifactPath(store, attempt, name)));
    stage.review = {
      taskId: task.id,
      attemptId: attempt.id,
      workerId: attempt.workerId,
      path: attempt.artifacts[0].path,
      hash: attempt.artifacts[0].hash,
      verdict: report.verdict,
    };
    const passed =
      report.verdict === 'pass' &&
      attempt.candidateReview.passed &&
      ![...(attempt.result.checks || []), ...(attempt.controllerChecks || [])].some(c => c.status === 'fail');
    Object.assign(stage, {
      current: passed ? 'waiting-for-integration' : 'failed',
      reason: passed ? '' : 'Independent review requested changes.',
    });
  }
  store.putTask(task);
}
// Resolve the story to the existing protected integration operation. Legacy
// review tasks pass through unchanged; no historical provenance is rewritten.
// The director may integrate over an accepted review that requested changes, with a reason
// (MP-019). Autonomy never passes an override; candidate tests and verification still apply.
function reviewOverride(override) {
  if (override === undefined) return undefined;
  if (!override || typeof override.reason !== 'string' || !override.reason.trim() || override.reason.length > 2000)
    throw new Error('Integrating over a review that requested changes needs your reason, in at most 2000 characters.');
  return { reason: override.reason.trim() };
}
export function sourceIntegrationTarget(store, task, attemptId, reviewHash, { override } = {}) {
  if (task.kind !== 'studio-development:change') return task;
  const stage = task.sourceStage,
    ref = stage?.review,
    overridden = !!reviewOverride(override);
  if (
    !ref ||
    (ref.verdict !== 'pass' && !(overridden && ref.verdict === 'needs-work')) ||
    task.status !== 'done' ||
    task.acceptedAttemptId !== ref.attemptId ||
    attemptId !== ref.attemptId ||
    reviewHash !== ref.hash ||
    !['waiting-for-integration', 'integrated', 'failed', 'blocked'].includes(stage.current)
  )
    throw new Error('Select the exact accepted passing current candidate review for integration.');
  const review = store.attempt(ref.attemptId);
  if (!equal(review.candidateReview, acceptedCandidate(store, review.assignment)))
    throw new Error('Accepted candidate identity changed.');
  return { ...task, kind: 'studio-development:change-review' };
}
// The story's current independent review when the autonomy policy may request its integration
// (MP-023): accepted, passing with no blocking findings, and not yet tried. A review that requested
// changes, and an integration that was tried and stopped, stay with the director. The integration
// request still checks everything above.
export function sourceStoryIntegrable(store, task) {
  const stage = task.sourceStage,
    ref = stage?.review;
  if (
    task.kind !== 'studio-development:change' ||
    task.status !== 'done' ||
    stage?.current !== 'waiting-for-integration' ||
    ref?.verdict !== 'pass' ||
    task.acceptedAttemptId !== ref.attemptId ||
    // Only an integration of this review stops it; one of an earlier review, rejected before the story was merged onto
    // the current source, does not (November 2, 2026: the merged story then waited for the director).
    stage.integration?.attemptId === ref.attemptId
  )
    return null;
  const review = store.attempt(ref.attemptId);
  if (review.sourceIntegration || review.candidateReviewFindings?.length) return null;
  return { attemptId: ref.attemptId, reviewHash: ref.hash, reason: `independent review ${ref.attemptId} passed` };
}
export function sourceIntegrationRequested(runtime, task) {
  const current = runtime.store.task(task.id);
  current.reason = '';
  delete current.autonomyNote;
  if (current.kind === 'studio-development:change' && current.sourceStage?.review?.attemptId === task.acceptedAttemptId)
    Object.assign(current.sourceStage, { phase: 'integration', current: 'waiting-for-integration', reason: '' });
  runtime.store.putTask(current);
}
function sourceIntegrationProgress(runtime, task, result) {
  // Verification may finish after shutdown closed SQLite. Leave its uncertain
  // journal and reservations untouched for explicit restart reconciliation.
  if (runtime.closing) return;
  const story = runtime.store.task(task.id),
    stage = story.sourceStage;
  if (story.acceptedAttemptId !== task.acceptedAttemptId) return;
  const resolved = ['verifying', 'integrated', 'abandoned', 'restored'].includes(result.state),
    reason = ['abandoned', 'restored'].includes(result.state)
      ? 'Interrupted integration reconciled. Approve integration again to retry.'
      : resolved
        ? ''
        : result.error || '';
  story.reason = reason;
  if (resolved) delete story.autonomyNote;
  else if (story.autonomyNote) story.autonomyNote = reason;
  if (story.kind !== 'studio-development:change' || stage?.review?.attemptId !== task.acceptedAttemptId) {
    runtime.store.putTask(story);
    return;
  }
  Object.assign(stage, {
    phase: 'integration',
    current:
      result.state === 'integrated'
        ? 'integrated'
        : ['verifying', 'abandoned', 'restored'].includes(result.state)
          ? 'waiting-for-integration'
          : 'failed',
    reason,
    integration: { attemptId: task.acceptedAttemptId, id: result.id, state: result.state },
  });
  runtime.store.putTask(story);
}
export function sourceIntegrationFailure(runtime, task, reason) {
  if (runtime.closing) return;
  const story = runtime.store.task(task.id);
  if (
    story.status !== 'done' ||
    (story.kind !== 'studio-development:change-review' &&
      (story.kind !== 'studio-development:change' ||
        story.sourceStage?.review?.verdict !== 'pass' ||
        story.acceptedAttemptId !== story.sourceStage.review.attemptId))
  )
    return;
  story.reason = reason;
  if (story.autonomyNote) story.autonomyNote = reason;
  if (story.kind === 'studio-development:change')
    Object.assign(story.sourceStage, { phase: 'integration', current: 'failed', reason });
  runtime.store.putTask(story);
}
export function acceptedCandidate(store, task) {
  if (!task.sourceStage && task.dependencies.length !== 1)
    throw new Error('Choose exactly one accepted source candidate.');
  const ref = task.sourceStage
      ? sourceCandidateReference(store, task)
      : acceptedReference(store, task.dependencies[0], undefined, recordProject(task)),
    attempt = store.attempt(ref.attemptId);
  if (attempt.assignment.kind !== 'studio-development:change' || attempt.workerId === task.workerId)
    throw new Error('Source candidates require review by a different employee.');
  const read = name => fs.readFileSync(artifactPath(store, attempt, name));
  const { manifest, report } = validateSourceChange(attempt, read);
  validateAcceptedReferences(store, attempt.assignment.acceptedInputs, recordProject(task));
  if (attempt.sourceChange.acceptedInputs)
    validateAcceptedReferences(store, attempt.sourceChange.acceptedInputs, recordProject(task));
  if (
    attempt.checkExecution.fixture !== false ||
    attempt.sourceEditExecution.fixture !== false ||
    attempt.sourceEditExecution.exitCode !== 0 ||
    attempt.sourceEditExecution.signal
  )
    throw new Error('Candidate review requires measured execution, not protocol fixtures.');
  return {
    ...identity(ref, 'source-change.json'),
    candidateHash: manifest.candidateHash,
    passed:
      report.passed &&
      ![...(attempt.result.checks || []), ...(attempt.controllerChecks || [])].some(c => c.status === 'fail'),
  };
}
export function validateChangeReview(attempt, read) {
  if (
    attempt.artifacts.length !== 1 ||
    attempt.artifacts[0].path !== 'source-change-review.json' ||
    attempt.artifacts[0].kind !== 'source-change-review'
  )
    throw new Error('Return only the registered candidate review artifact.');
  const report = JSON.parse(read('source-change-review.json')),
    source = attempt.candidateReview;
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error('Candidate review must be a JSON object.');
  const bounded = text => typeof text === 'string' && !!text.trim() && text.length <= 8000;
  // Since MP-019 (contract v2) a review grades what it found: findings are blocking defects and notes
  // are non-blocking observations, and a review passes exactly when it has no findings. Reviews whose
  // attempt recorded v1 keep v1's rules, where a passing review could list findings.
  const graded = attempt.contracts?.task?.version !== 'source-change-review-v1',
    schemaVersion = graded ? 'source-change-review-v2' : 'source-change-review-v1';
  // Name every problem: an automatic retry receives this message as its direction.
  const problems = [];
  if (report.schemaVersion !== schemaVersion) problems.push(`schemaVersion must be ${schemaVersion}`);
  // Name each wrong value and what it must be, so a retry can copy it.
  const identity = ['taskId', 'attemptId', 'path', 'hash', 'candidateHash'];
  if (!report.source || typeof report.source !== 'object' || Object.keys(report.source).length !== 5)
    problems.push('source must hold exactly taskId, attemptId, path, hash and candidateHash of the input candidate');
  for (const key of identity)
    if (report.source?.[key] !== source[key]) problems.push(`source.${key} must be ${source[key]}`);
  if (!['pass', 'needs-work'].includes(report.verdict)) problems.push('verdict must be pass or needs-work');
  else if (!source.passed && report.verdict !== 'needs-work')
    problems.push('failing candidate tests require verdict needs-work');
  if (!bounded(report.summary)) problems.push('summary must be nonempty text of at most 8000 characters');
  if (!Array.isArray(report.findings) || report.findings.length > 20 || !report.findings.every(bounded))
    problems.push('findings must be an array of at most 20 plain strings, not objects');
  else if (report.verdict === 'needs-work' && !report.findings.length)
    problems.push('needs-work requires at least one finding');
  else if (graded && report.verdict === 'pass' && report.findings.length)
    problems.push(
      'findings are blocking defects, so a passing review has none; put non-blocking observations in notes',
    );
  if (graded && (!Array.isArray(report.notes) || report.notes.length > 20 || !report.notes.every(bounded)))
    problems.push('notes must be an array of at most 20 plain strings, empty when there are none');
  if (
    !Array.isArray(report.unperformedChecks) ||
    !['Browser layout', 'Engine integration', 'Playtest'].every(name => report.unperformedChecks.includes(name))
  )
    problems.push('unperformedChecks must include Browser layout, Engine integration and Playtest');
  // The reviewer must look (1.2 step 8): a candidate with captured pages is described image by image.
  problems.push(...reviewVisualProblems(report, reviewedImages(attempt)));
  if (problems.length)
    throw new Error(
      `Candidate review must assess the exact candidate and label unperformed checks: ${problems.join('; ')}.`,
    );
  return report;
}

// Who approved an integration: the director, or the autonomy policy after a passing review (MP-023),
// which never integrates over a review.
function integrationApproval(by = { type: 'director' }, override) {
  if (by.type === 'director') return { type: 'director' };
  if (by.type !== 'policy' || !Number.isInteger(by.revision) || typeof by.reason !== 'string' || override)
    throw new Error('Only the director, or the autonomy policy after a passing review, approves integration.');
  return { type: 'policy', revision: by.revision, reason: by.reason };
}
// What the director's reason covered, in words: the review's verdict when it requested changes, and the names of
// its failed checks.
function overriddenReview(verdict, checks) {
  const named = checks.length ? `failed check${checks.length === 1 ? '' : 's'} ${checks.join(', ')}` : '';
  if (verdict === 'pass' && named) return `the review's ${named}`;
  return `the review's ${verdict} verdict${named ? ` and its ${named}` : ''}`;
}
// Integration runs in two parts (MP-016). The synchronous part validates the exact reviewed
// candidate and its commit, and records a journal holding the source reservations. The
// controller then merges that commit onto the current tip of the development copy's branch in
// an integration worktree, formats and tests the result there, commits it and fast-forwards the
// development copy to that commit. Nothing reaches the development copy unless verification passes.
export function integrateSource(runtime, task, attemptId, reviewHash, onSettled = () => {}, options = {}) {
  const store = runtime.store,
    override = reviewOverride(options.override),
    approval = integrationApproval(options.by, override);
  task = sourceIntegrationTarget(store, task, attemptId, reviewHash, { override });
  if (typeof attemptId !== 'string' || attemptId !== task.acceptedAttemptId)
    throw new Error('Select the exact accepted candidate review for integration.');
  const ref = acceptedReference(store, task.id, attemptId, recordProject(task)),
    review = store.attempt(ref.attemptId);
  if (
    task.kind !== 'studio-development:change-review' ||
    identity(ref, 'source-change-review.json').hash !== reviewHash
  )
    throw new Error('Select the exact accepted candidate review for integration.');
  const verdict = validateChangeReview(review, name => fs.readFileSync(artifactPath(store, review, name)));
  // The director's override covers the review's verdict and its failed checks, its own and the controller's (as the
  // story's stage and the autonomy policy count them), never the candidate's tests.
  const failedChecks = [...review.result.checks, ...(review.controllerChecks || [])]
    .filter(check => check.status === 'fail')
    .map(check => String(check.name || 'Unnamed check'));
  if (!override && (verdict.verdict !== 'pass' || failedChecks.length))
    throw new Error(
      'Integration requires a passing independent review whose checks passed, or your reason to integrate over it.',
    );
  const candidateRef = acceptedCandidate(store, review.assignment),
    candidate = store.attempt(candidateRef.attemptId);
  if (!equal(candidateRef, review.candidateReview)) throw new Error('Accepted candidate identity changed.');
  const { manifest, report } = validateSourceChange(candidate, name =>
    fs.readFileSync(artifactPath(store, candidate, name)),
  );
  if (!report.passed || candidate.result.checks.some(check => check.status === 'fail'))
    throw new Error('Integration requires all candidate tests to pass without skips.');
  const previous = review.sourceIntegration;
  if (previous?.state === 'integrated') return previous;
  if (previous?.state === 'verifying' && runtime.sourceIntegrationRun?.id === previous.id) return previous;
  if (previous && !['rejected', 'abandoned'].includes(previous.state))
    throw new Error('Reconcile the recorded source integration before another mutation.');
  // The story integrates into the repository its scope measured: its project's (1.0 item 9), onto
  // the line its scope started from (1.1 step 1).
  const root = candidate.sourceChange?.source?.root || runtime.sourceChangeRoot,
    commit = candidate.sourceCandidate?.commit,
    repository = lineRepository(root, projectLine(store, recordProject(task), candidate.sourceChange?.base?.branch));
  // A controller that develops its own source replaces its running modules, so it integrates
  // onto its checked-out branch only while paused and idle, then restarts. Otherwise integration
  // holds only its resources.
  if (
    runtime.selfHosted &&
    root === runtime.sourceChangeRoot &&
    repository.live !== false &&
    (!store.organization().paused || runtime.active.size || store.leases().length)
  )
    throw new Error('Pause dispatch and finish or reconcile active work before integrating source.');
  if (!commit)
    throw new Error('This candidate was built before candidates were commits (MP-016). Request a fresh candidate.');
  const changes = manifest.changes.map(item => {
    if (item.afterHash === null) return { path: item.path, file: null, status: 'D' };
    const file = artifactPath(store, candidate, item.artifact);
    if (hash(fs.readFileSync(file)) !== item.afterHash) throw new Error('Candidate edit changed before integration.');
    return { path: item.path, file, status: item.beforeHash === null ? 'A' : 'M' };
  });
  verifyCandidateCommit(root, commit, candidate.sourceWorktree?.baseCommit, changes);
  const journal = {
    id: 'source-integration:' + review.id,
    phaseOccurrenceId: randomUUID(),
    reviewAttemptId: review.id,
    reviewTaskId: review.taskId,
    method: 'merge',
    state: 'verifying',
    root,
    candidateAttemptId: candidate.id,
    reviewHash,
    baseHash: manifest.baseHash,
    candidateHash: manifest.candidateHash,
    candidateCommit: commit,
    changes: manifest.changes,
    repository,
    worktree: path.join(sourceWorktreeRoot(runtime), 'i-' + worktreeName(review.id)),
    ...testFloorOf(store, root, repository.branch, report.totals?.tests),
    startedAt: new Date().toISOString(),
    approvedBy: approval,
    ...(override
      ? {
          reviewOverride: {
            by: { type: 'director' },
            verdict: verdict.verdict,
            ...(failedChecks.length ? { checks: failedChecks } : {}),
            reason: override.reason,
            at: new Date().toISOString(),
          },
        }
      : {}),
    ...(previous
      ? { previous: { state: previous.state, error: previous.error, finishedAt: previous.finishedAt } }
      : {}),
  };
  store.tx(() => {
    store.claim(sourceResources(store, task), journal.id);
    review.sourceIntegration = journal;
    store.updateAttempt(review);
  });
  store.event(
    'source_verifying',
    task.id,
    review.id,
    `Integration approved${override ? ` over ${overriddenReview(verdict.verdict, failedChecks)}, by the director: ${override.reason}` : approval.type === 'policy' ? ` by autonomy policy revision ${approval.revision} after the independent review passed` : ' by the director'}. The controller is merging the reviewed change onto ${journal.repository.branch} at ${journal.repository.head.slice(0, 7)} in its own worktree, then formatting and testing it; ${journal.repository.live === false ? journal.repository.branch : 'the development copy'} is unchanged until it passes.`,
  );
  sourceIntegrationProgress(runtime, task, journal);
  const promise = finishIntegration(runtime, task, review, candidate)
    .catch(error => ({ ...review.sourceIntegration, state: 'needs-reconciliation', error: error.message }))
    .then(result => {
      if (runtime.sourceIntegrationRun?.id === journal.id) runtime.sourceIntegrationRun = null;
      if (!runtime.closing) {
        sourceIntegrationProgress(runtime, task, result);
        onSettled(result);
      }
      return result;
    });
  runtime.sourceIntegrationRun = { id: journal.id, promise };
  return structuredClone(journal);
}
// The fewest tests a story's merge may report (testFloor): the count the newest integrated story on the same repository
// and branch passed with, named by that story's task ID, lowered to the change's own measured count, since a reviewed
// change may remove tests on purpose. With no integrated story on the line there is no floor.
function testFloorOf(store, root, branch, candidateTests) {
  let newest = null;
  for (const { sourceIntegration: journal } of store.integrationJournals('integrated'))
    if (
      journal.root === root &&
      journal.repository?.branch === branch &&
      Number.isInteger(journal.verification?.totals?.tests) &&
      (!newest || String(journal.finishedAt) >= String(newest.finishedAt))
    )
      newest = journal;
  if (!newest) return {};
  let taskId = newest.reviewTaskId;
  try {
    taskId = store.attempt(newest.candidateAttemptId).taskId || taskId;
  } catch {}
  const lineTests = newest.verification.totals.tests,
    measured = Number.isInteger(candidateTests) ? candidateTests : null;
  return {
    testFloor: {
      tests: measured === null ? lineTests : Math.min(lineTests, measured),
      lineTests,
      candidateTests: measured,
      taskId,
      integrationId: newest.id,
    },
  };
}
function settle(store, review, journal, state, fields = {}) {
  Object.assign(journal, fields, { state, finishedAt: new Date().toISOString() });
  store.tx(() => {
    store.updateAttempt(review);
    store.release(journal.id);
  });
  return structuredClone(journal);
}
async function finishIntegration(runtime, task, review, candidate) {
  const store = runtime.store,
    journal = review.sourceIntegration,
    root = journal.root,
    directory = path.join(jobDirectory(store, review), 'integration');
  let verification;
  try {
    observeIntegrationPhase(runtime, journal, 'integration.prepare', () => {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.mkdirSync(directory, { recursive: true });
      // A worktree left by an earlier, settled try of this review is replaced.
      if (fs.existsSync(journal.worktree)) removeSourceWorktree(root, journal.worktree);
      createSourceWorktree(
        root,
        path.dirname(journal.worktree),
        path.basename(journal.worktree),
        journal.repository.head,
        profileOf(candidate.sourceCandidate),
      );
    });
    verification = await verifyIntegration(
      runtime,
      journal,
      directory,
      candidate.configuration,
      profileOf(candidate.sourceCandidate),
    );
  } catch (error) {
    verification = { passed: false, error: error.message };
  }
  // A shutdown stops verification; the journal and its worktree stay until reconciled.
  if (runtime.closing) return structuredClone(journal);
  journal.verification = verification;
  const discard = () => {
    try {
      removeSourceWorktree(root, journal.worktree);
    } catch {}
  };
  const reject = reason => {
    const result = settle(store, review, journal, 'rejected', { error: reason });
    discard();
    store.event(
      'source_rejected',
      task.id,
      review.id,
      `Integration stopped before changing the development copy: ${reason} Reservations released.`,
    );
    return result;
  };
  if (!verification.passed) {
    const reason =
      verification.error ||
      (verification.totals
        ? `${verification.totals.pass}/${verification.totals.tests} tests passed on the formatted change.`
        : 'The test run did not report complete totals.');
    // A change that passed its own tests and fails merged onto work that landed since keeps its change: it can be
    // merged onto the current source for its editor, as a conflicting one is (October 27).
    const failed =
        !verification.conflicts?.length && (verification.totals?.fail > 0 || /^The build failed/.test(reason)),
      landed = failed ? landedSince(root, journal) : null;
    if (!landed) return reject(reason);
    verification.landedSince = landed;
    return reject(
      `${reason} It passed its own tests, and ${landedText(store, landed)} landed after it was tested: together they fail. Use Merge onto the current source: its editor makes the change work with what landed.`,
    );
  }
  journal.changes = journal.changes.map(item => ({
    ...item,
    integratedHash: verification.files.find(file => file.path === item.path).integratedHash,
  }));
  try {
    journal.commit = observeIntegrationPhase(runtime, journal, 'integration.commit', () =>
      commitIntegration(
        journal.worktree,
        journal.changes.map(item => item.path),
        commitMessage(store, review, candidate, journal),
        directory,
      ),
    );
  } catch (error) {
    return reject(error.message);
  }
  // From here the development copy may move, so an interruption is reconciled from git history.
  journal.state = 'committing';
  store.updateAttempt(review);
  const attention = message => {
    journal.state = 'needs-reconciliation';
    journal.error = message;
    store.updateAttempt(review);
    store.event(
      'source_attention',
      task.id,
      review.id,
      `Source integration stopped part-way; reservations retained. Inspect the development copy, then use Reconcile source integration. ${message}`,
    );
    return structuredClone(journal);
  };
  try {
    observeIntegrationPhase(runtime, journal, 'integration.fast-forward', () => {
      moveLine(root, journal);
      if (!lineReached(root, journal))
        throw Object.assign(new Error('The development copy did not reach the integration commit.'), { partial: true });
    });
  } catch (error) {
    return error.partial ? attention(error.message) : reject(error.message);
  }
  if (!lineReached(root, journal)) return attention('The development copy did not reach the integration commit.');
  const result = settle(store, review, journal, 'integrated', {
    repository: { ...journal.repository, commit: journal.commit },
  });
  discard();
  store.event(
    'source_integrated',
    task.id,
    review.id,
    `Integrated the reviewed change, merged onto ${journal.repository.branch} at ${journal.repository.head.slice(0, 7)}, formatted and tested, as commit ${journal.commit.slice(0, 7)}.${runtime.selfHosted ? ' Restart the controller to load changed modules.' : ''}`,
  );
  // A fix on an older line is carried forward to the newer ones (1.1 step 4).
  planCarries(store, store.task(task.id), review.id, result);
  return result;
}
function commitMessage(store, review, candidate, journal) {
  const change = store.task(candidate.taskId),
    proposal = candidate.sourceChange.proposalReference,
    { totals, formatter, fixture } = journal.verification;
  return [
    change.title,
    '',
    // Journals from before the policy could integrate (MP-023) were approved by the director.
    journal.approvedBy?.type === 'policy'
      ? `Integrated by Studio desk after a passing review, approved by autonomy policy revision ${journal.approvedBy.revision}.`
      : 'Integrated by Studio desk after director approval.',
    '',
    `Proposal: ${proposal.taskId} (${proposal.attemptId})`,
    `Change: ${change.id} (${candidate.id}), candidate ${journal.candidateHash}`,
    journal.reviewOverride
      ? `Candidate review: ${review.taskId} (${review.id}), verdict ${journal.reviewOverride.verdict}${journal.reviewOverride.checks?.length ? `, failed checks: ${journal.reviewOverride.checks.join(', ')}` : ''}; integrated over it by the director: ${journal.reviewOverride.reason}`
      : `Candidate review: ${review.taskId} (${review.id}), verdict pass`,
    formatter === 'none'
      ? `Verification: no formatter in the source profile; ${testsSentence(totals)} on the merged source${fixture ? ' (protocol fixture)' : ''}.`
      : `Verification: ${formatter} on changed files; ${testsSentence(totals)} on the formatted source${fixture ? ' (protocol fixture)' : ''}.`,
    '',
    integrationTrailer(journal),
    '',
  ].join('\n');
}
// Integrations the controller's stop cut off (the recovery drill, v1.0 criterion 3). A clean stop ends the
// integration's process, which records it as needing reconciliation; a stop that ends the controller at once, as
// closing its window does, leaves the journal where it was, with nothing left to finish it and its resources held.
// When the controller starts, no integration of its own is running yet, so each such journal becomes uncertain and
// waits for Reconcile source integration, keeping the state it had reached (`interrupted`): reconciling one cut off
// in verification, which never writes the development copy, asks nothing about local edits.
//
// The computer's one test turn is the exception, as it is for an interrupted attempt (core/orchestrator.mjs): every
// other full suite waits for it, so a journal that holds it gives back that one lease when the process of the step it
// recorded running under the turn (testProcess, source-integration.mjs) is confirmed gone, by the process identity
// every caller shares (live, adapters/process.mjs: its ID with when it started, so a later process handed the ID is
// not taken for it). The journal stays needs-reconciliation with its other leases. One whose recorded process may
// still run, or that recorded none (a journal from before it recorded one), keeps the turn until it is reconciled.
const turnFreedOnRestart =
  "The test turn was freed: the integration's test run that held it had ended when the controller started again. Only the run's own process was checked; processes it started are not tracked yet and may outlive it.";
const testRunEnded = journal =>
  !!journal.testProcess?.pid && !live({ pid: journal.testProcess.pid, pidStartedAt: journal.testProcess.startedAt });
export function interruptedSourceIntegrations(runtime) {
  const store = runtime.store;
  for (const review of store.allAttempts()) {
    const journal = review.sourceIntegration;
    if (!journal || !['verifying', 'preparing', 'prepared', 'applying', 'committing'].includes(journal.state)) continue;
    journal.interrupted = journal.state;
    journal.state = 'needs-reconciliation';
    journal.error = 'The controller stopped while this integration was running.';
    store.updateAttempt(review);
    store.event(
      'source_attention',
      review.taskId,
      review.id,
      `Source integration stopped part-way when the controller stopped (during ${journal.interrupted}); reservations retained. Use Reconcile source integration.`,
    );
    if (
      store.leases().some(lease => lease.resource === testTurnResource && lease.attemptId === journal.id) &&
      testRunEnded(journal)
    )
      store.tx(() => {
        store.releaseResource(testTurnResource, journal.id);
        store.event('test_turn', review.taskId, review.id, turnFreedOnRestart);
      });
  }
  // Carries and releases cut off the same way (1.1 steps 4 and 5) are reconciled at once from git history.
  interruptedCarries(runtime);
  interruptedReleases(runtime);
}
// An integration by merge writes the development copy only by fast-forwarding it to the
// recorded commit, so git history says whether it landed. Nothing is restored or replayed.
function reconcileMerge(runtime, task, review, journal) {
  const store = runtime.store,
    discard = () => {
      try {
        removeSourceWorktree(journal.root, journal.worktree);
      } catch {}
    };
  if (journal.commit && lineReached(journal.root, journal)) {
    const result = settle(store, review, journal, 'integrated', {
      repository: { ...journal.repository, commit: journal.commit },
    });
    discard();
    sourceIntegrationProgress(runtime, task, result);
    store.event(
      'source_integrated',
      task.id,
      review.id,
      `Reconciled: the reviewed change had reached ${journal.repository.branch} as commit ${journal.commit.slice(0, 7)}.${runtime.selfHosted ? ' Restart the controller to load changed modules.' : ''}`,
    );
    planCarries(store, store.task(task.id), review.id, result);
    return result;
  }
  // Verification never writes the development copy. A fast-forward refuses local edits to the
  // changed files, so edits there now may be what an interrupted one left: the director decides.
  // A line that is not checked out moves in one step and leaves no files behind.
  if ((journal.interrupted ?? journal.state) !== 'verifying' && journal.repository?.live !== false) {
    const edited = statusPaths(
      journal.root,
      journal.changes.map(item => item.path),
    );
    if (edited.length)
      throw new Error(
        `The development copy has uncommitted changes to ${edited.join(', ')}, which an interrupted fast-forward may have left. Restore or commit them with git, then reconcile again.`,
      );
  }
  const result = settle(store, review, journal, 'abandoned', {
    error: journal.error || 'Integration was interrupted before it reached the development copy.',
  });
  discard();
  sourceIntegrationProgress(runtime, task, result);
  store.event(
    'source_restored',
    task.id,
    review.id,
    'Interrupted integration reconciled; the development copy is unchanged. Approve integration again to retry.',
  );
  return result;
}
export function restoreSourceIntegration(runtime, task) {
  const store = runtime.store,
    ref = task.sourceStage?.review,
    // A merge the director approved over the review that requested changes is checked with the reason its journal
    // recorded, so it can be reconciled too; any other journal is checked exactly as before.
    recorded =
      task.kind === 'studio-development:change' && ref?.attemptId && ref.attemptId === task.acceptedAttemptId
        ? store.attempt(ref.attemptId)?.sourceIntegration
        : undefined,
    override =
      recorded?.reviewOverride && recorded.reviewHash === ref.hash
        ? { reason: recorded.reviewOverride.reason }
        : undefined;
  task = sourceIntegrationTarget(store, task, task.acceptedAttemptId, ref?.hash, { override });
  const review = store.attempt(task.acceptedAttemptId),
    journal = review.sourceIntegration;
  if (
    task.kind !== 'studio-development:change-review' ||
    !journal ||
    !['verifying', 'preparing', 'prepared', 'applying', 'committing', 'needs-reconciliation'].includes(journal.state) ||
    // The journal's repository must still be its project's (1.0 item 9), not only the controller's own.
    journal.root !== sourceRoot(store, task, runtime) ||
    runtime.sourceIntegrationRun?.id === journal.id
  )
    throw new Error('Choose an uncertain source integration to reconcile.');
  if (journal.method === 'merge') return reconcileMerge(runtime, task, review, journal);
  if (runtime.active.size || !store.organization().paused)
    throw new Error('Pause dispatch and choose an uncertain source integration to restore.');
  // The commit may have landed before its journal was updated; never undo a recorded commit.
  const commit =
    ['committing', 'needs-reconciliation'].includes(journal.interrupted ?? journal.state) &&
    committedIntegration(journal.root, journal);
  if (commit) {
    const result = settle(store, review, journal, 'integrated', { repository: { ...journal.repository, commit } });
    sourceIntegrationProgress(runtime, task, result);
    store.event(
      'source_integrated',
      task.id,
      review.id,
      `Reconciled: the reviewed change was already committed as ${commit.slice(0, 7)}. Restart the controller to load changed modules.`,
    );
    return result;
  }
  // Verification never writes live source, so an interrupted one only needs that confirmed.
  if ((journal.interrupted ?? journal.state) === 'verifying') {
    const live = sourcePlan(journal.root);
    if (journal.changes.some(item => live.files.find(file => file.path === item.path)?.hash !== item.beforeHash))
      throw new Error('Source differs from the recorded original. Manual reconciliation is required.');
    const result = settle(store, review, journal, 'abandoned', {
      error: journal.error || 'Verification was interrupted.',
    });
    sourceIntegrationProgress(runtime, task, result);
    store.event(
      'source_restored',
      task.id,
      review.id,
      'Interrupted integration verification reconciled; live source was unchanged. Approve integration again to retry.',
    );
    return result;
  }
  const backups = path.join(jobDirectory(store, review), 'source-backup'),
    plan = sourcePlan(journal.root);
  const restore = [];
  for (const item of journal.changes) {
    const applied = item.integratedHash || item.afterHash,
      current = plan.files.find(file => file.path === item.path),
      backup = path.join(backups, item.path);
    if (
      !current ||
      ![item.beforeHash, applied].includes(current.hash) ||
      (fs.existsSync(backup) && hash(fs.readFileSync(backup)) !== item.beforeHash) ||
      (current.hash === applied && !fs.existsSync(backup))
    )
      throw new Error('Source or backup differs from both recorded states. Manual reconciliation is required.');
    if (current.hash === applied) restore.push(item);
  }
  const temporary = path.join(journal.root, '.studio-source-' + review.id + '.tmp');
  if (fs.existsSync(temporary)) {
    const stat = fs.lstatSync(temporary);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Unexpected integration temporary file. Manual reconciliation is required.');
    fs.unlinkSync(temporary);
  }
  for (const item of restore)
    replaceFile(journal.root, item.path, fs.readFileSync(path.join(backups, item.path)), review.id);
  const restored = sourcePlan(journal.root);
  if (journal.changes.some(item => restored.files.find(file => file.path === item.path)?.hash !== item.beforeHash))
    throw new Error('Source checkpoint restoration could not be verified. Reservations retained.');
  journal.state = 'restored';
  journal.finishedAt = new Date().toISOString();
  store.tx(() => {
    store.updateAttempt(review);
    store.release(journal.id);
  });
  store.event(
    'source_restored',
    task.id,
    review.id,
    'Director restored recorded source files from the integration checkpoint. No mutation was replayed.',
  );
  sourceIntegrationProgress(runtime, task, journal);
  return journal;
}
