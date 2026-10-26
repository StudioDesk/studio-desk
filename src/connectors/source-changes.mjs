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
import { profileOf, recordedProfile, storyPathAllowed, storyPathRule, studioDeskProfile } from './source-profile.mjs';
import { sourceResources, sourceRoot, studioDeskSourceResources } from './source-projects.mjs';
import { sourceDiffFormat, sourceDiffLimit, verifySourceDiff } from './source-diff.mjs';
import { codexSandboxRecord, sandboxRecord, testSandboxOf } from '../adapters/source-test-sandbox.mjs';
import { builtInSandboxRunner } from '../adapters/built-in-sandbox.mjs';
import {
  commitIntegration,
  committedIntegration,
  fastForward,
  integrationTrailer,
  landed,
  repositoryState,
  statusPaths,
  verifyCandidateCommit,
  verifyIntegration,
  observeIntegrationPhase,
} from './source-integration.mjs';
import {
  committedPaths,
  createSourceWorktree,
  ignoredPaths,
  removeSourceWorktree,
  sourceBase,
  sourceWorktreeRoot,
  worktreeName,
} from './source-worktrees.mjs';

export const sourceChangesConnector = Object.freeze({
  id: 'local-source-changes',
  version: 'source-changes-v1',
  resource: 'source:studio-desk-integration',
});
// A Studio desk integration holds these exclusively, and a pending one goes next on them; a project
// with its own repository holds that repository's (sourceResources).
export const sourceIntegrationResources = studioDeskSourceResources;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
      ],
      'Breakdown story',
    );
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
  for (const file of [...files, ...deleteFiles])
    if (!storyPathAllowed(file, profile) || !manifest.some(item => item.path === file))
      throw new Error(
        `${name} lists unsupported or unrecorded source file ${String(file)}; choose an allowed existing path from the measured manifest.`,
      );
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
export function breakdownEvidence(store, attempt, projectId, storyKey, pathsOf = story => story) {
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
    current = sourcePlan(checked.sourceCheck.root, profileOf(checked.sourceCheck));
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
    });
  }
  return { report, source, checkedReference: acceptedReference(store, source.taskId, source.attemptId, projectId) };
}

const staleBreakdown = { since: 'the breakdown', action: 'Request fresh measured evidence and a new breakdown.' };
const named = files => files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');
// Checks a story's paths against the current source and returns the scope to dispatch. A file may
// differ from the measured bytes by a change an integrated story committed (MP-016 slice 4), whose
// hash an integration into this source left, or by any change committed on the development copy's
// branch (MP-021): the editor starts from the current commit and integration merges. A listed file
// that is gone, or that holds uncommitted edits, still stops the story. A new file the story's
// integrated prerequisite stories created is edited like any other existing file (MP-014 slice 4);
// other new files must still be absent, and not ignored by git.
function verifyStoryScope(
  paths,
  current,
  original,
  { integrated = new Map(), created: prerequisites = new Map() } = {},
  stale = staleBreakdown,
) {
  validateStoryPaths(paths, original, undefined, profileOf(current));
  const { files, newFiles, deleteFiles } = scopePaths(paths),
    now = file => current.files.find(item => item.path === file),
    created = newFiles.filter(file => now(file) && prerequisites.get(file)?.has(now(file).hash)),
    absent = newFiles.filter(file => !created.includes(file));
  const missing = [...files, ...deleteFiles].filter(file => !now(file)),
    drifted = [...files, ...deleteFiles].filter(file => {
      const item = now(file),
        before = original.find(item => item.path === file);
      return (
        item && (item.hash !== before.hash || item.bytes !== before.bytes) && !integrated.get(file)?.has(item.hash)
      );
    }),
    committed = committedPaths(current.root, drifted),
    uncommitted = drifted.filter(file => !committed.includes(file));
  if (missing.length) throw new Error(`Approved source files no longer exist: ${named(missing)}. ${stale.action}`);
  if (uncommitted.length)
    throw new Error(
      `Approved source files changed since ${stale.since}, and the changes are not committed: ${named(uncommitted)}. Commit or discard them in the development copy, then try again.`,
    );
  const taken = takenPaths(current.files);
  for (const file of absent)
    if (newPathProblem(file, taken))
      throw new Error(`${file} now exists or collides with an existing path, so it cannot be created. ${stale.action}`);
  const ignored = ignoredPaths(current.root, absent);
  if (ignored.length)
    throw new Error(`git ignores ${ignored.join(', ')}, so a story cannot create it. Choose another path.`);
  const allowedFiles = [...files, ...created];
  for (const file of allowedFiles) {
    const bytes = fs.readFileSync(path.join(current.root, file));
    if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))
      throw new Error('Approved source files must be UTF-8 text.');
  }
  return { allowedFiles, newFiles: absent, deleteFiles: [...deleteFiles] };
}

// The paths a story may change: the director's latest edit (editSourceStory) when there is one,
// otherwise the paths its breakdown story or review proposal listed.
const storyPaths = (task, proposed) => scopePaths(task.scopeEdits?.at(-1) || proposed);
const implementationAttempts = (store, task) =>
  store.attempts(task.id).filter(attempt => (attempt.assignment?.kind || task.kind) === 'studio-development:change');
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
    skipped = [];
  for (const item of manifest.files) {
    const file = item.path.slice('changes/'.length);
    if (!item.path.startsWith('changes/') || item.hash === before(file)) continue;
    if (writable.includes(file)) files.push({ path: file, hash: item.hash });
    else skipped.push({ path: file, reason: 'no longer in the approved files' });
  }
  const deleted = scope.deleteFiles || [];
  for (const file of deleted)
    if (!paths.deleteFiles.includes(file)) skipped.push({ path: file, reason: 'no longer approved for deletion' });
  const conflicts = [
    ...files.map(item => item.path),
    ...deleted.filter(file => paths.deleteFiles.includes(file)),
  ].filter(file => before(file) !== now(file));
  if (conflicts.length) return fresh('the source of files it changed was committed since that attempt', conflicts);
  return files.length || skipped.length ? { attemptId: previous.id, files, skipped } : null;
}
// Why an attempt starts from the current source although earlier work was recorded.
export const freshStartText = carried =>
  carried?.fresh
    ? `This attempt starts from the current source instead of the work of ${carried.attemptId}: ${carried.fresh.reason}${carried.fresh.paths ? ` (${carried.fresh.paths.join(', ')})` : ''}. Its history still shows that work.`
    : '';
// What every scope carries besides its paths: the director's edits and the work it continues from.
function storyScopeExtras(store, task, paths, current) {
  const continueFrom = continuedWork(store, task, paths, current);
  return {
    ...(task.scopeEdits?.length ? { scopeEdits: structuredClone(task.scopeEdits) } : {}),
    ...(continueFrom ? { continueFrom } : {}),
  };
}
function breakdownChangeScope(store, task, root, dryRun) {
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
    } = breakdownEvidence(store, attempt, recordProject(task), reference.key, story => storyPaths(task, story)),
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
    current = sourcePlan(root, profile);
  if (current.root !== store.attempt(evidence.attemptId).sourceCheck.root)
    throw new Error('The controller source target changed. Request fresh measured evidence and a new breakdown.');
  const paths = verifyStoryScope(storyPaths(task, story), current, evidence.files, {
    integrated: integratedSourceChanges(store, current.root),
    created: integratedChanges(store, siblings),
  });
  return {
    connector: sourceChangesConnector,
    proposalReference,
    reviewedSourceHash: evidence.sourceHash,
    proposal: structuredClone(story),
    source: current,
    ...(dryRun ? {} : { base: sourceBase(root, profile) }),
    ...paths,
    acceptedInputs: [ref, checkedReference, ...siblingInputs],
    ...storyScopeExtras(store, task, paths, current),
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
  for (const attempt of store.allAttempts()) {
    const journal = attempt.sourceIntegration;
    if (journal?.state === 'integrated' && journal.root === root)
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
// A started story holds the live source from its first edit until it is integrated, so its
// candidate stays buildable on the source it will be integrated into (MP-014 slice 4). It
// lets go when it is denied, cancelled, failed, or its review sent it back without a retry.
export function sourceStoryInFlight(store, task) {
  return store.tasks().find(other => {
    if (
      other.id === task.id ||
      other.kind !== 'studio-development:change' ||
      recordProject(other) !== recordProject(task) ||
      ['denied', 'cancelled', 'failed', 'backlog'].includes(other.status) ||
      sourceStoryIntegrated(other)
    )
      return false;
    // A live edit holds the source, including a story from before stages.
    if (['running', 'stopping', 'review'].includes(other.status)) return true;
    return !!other.sourceStage?.candidate && other.sourceStage.current !== 'failed';
  });
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
// The paths the story's accepted breakdown story or review proposal listed.
function proposedPaths(store, task) {
  const reference = task.proposalReference,
    attempt = store.attempt(reference.attemptId),
    bytes = fs.readFileSync(artifactPath(store, attempt, reference.path));
  if (hash(bytes) !== reference.hash) throw new Error('The accepted proposal changed after it was accepted.');
  const report = JSON.parse(bytes);
  return scopePaths(
    reference.path === 'source-breakdown.json'
      ? report.stories.find(story => story.key === reference.key)
      : report.proposal,
  );
}
const pathLists = ['files', 'newFiles', 'deleteFiles'],
  pathLabels = { files: 'Files', newFiles: 'New files', deleteFiles: 'Delete' },
  maxScopeEdits = 20;
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
  const at = new Date().toISOString(),
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
  const scope = changeScope(store, edited, root, { dryRun: true }),
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
        ? `Your edits from ${carried.attemptId} to ${carried.files.map(item => item.path).join(', ')} are already in changes/ (continueFrom in source-scope.json): continue from them. The controller includes them in the candidate even if you do not return them; to drop one, restore the file to its ../source content.`
        : '',
      carried?.skipped.length
        ? `Not carried over: ${carried.skipped.map(item => `${item.path} (${item.reason})`).join('; ')}.`
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
// with the director, since approving a story is what approves its deletions. Returns nothing when
// an edit already followed the request.
export function approveScopeRequest(store, task, attempt, root, by) {
  const request = attempt.scopeRequest;
  if (task.scopeEdits?.some(edit => edit.at >= attempt.finishedAt)) return null;
  if (request.deleteFiles.length)
    throw new Error(
      `The editor asked to delete ${named(request.deleteFiles)}; deletions stay with the director. Approve or change the requested files in the story.`,
    );
  const current = storyPaths(task, proposedPaths(store, task));
  try {
    return editSourceStory(
      store,
      task,
      {
        files: [...current.files, ...request.files],
        newFiles: [...current.newFiles, ...request.newFiles],
        deleteFiles: current.deleteFiles,
        reason: request.reason,
        request: attempt.id,
      },
      root,
      { by },
    );
  } catch (error) {
    throw new Error(`The requested files could not be approved automatically: ${error.message}`);
  }
}
// The scope a story's next implementation attempt receives. A dry run checks it without fixing
// the base commit, which needs a clean development copy only when the attempt starts.
export function changeScope(store, task, root, { dryRun = false } = {}) {
  if (task.approval?.status !== 'approved' || !task.proposalReference)
    throw new Error('Source editing requires approved work from one exact accepted source review.');
  validateAcceptedReferences(store, task.acceptedInputs, recordProject(task));
  if (task.proposalReference.path === 'source-breakdown.json') return breakdownChangeScope(store, task, root, dryRun);
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
  const checked = store.allAttempts().find(attempt => attempt.id === review.sourceReview?.attemptId);
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
    source = sourcePlan(root, profile),
    paths = verifyStoryScope(
      storyPaths(task, proposal),
      source,
      checked.sourceCheck.files,
      { integrated: integratedSourceChanges(store, source.root) },
      { since: 'the proposal', action: 'Request fresh evidence.' },
    );
  return {
    connector: sourceChangesConnector,
    proposalReference,
    reviewedSourceHash: checked.sourceCheck.sourceHash,
    proposal: structuredClone(proposal),
    source,
    ...(dryRun ? {} : { base: sourceBase(root, profile) }),
    ...paths,
    ...storyScopeExtras(store, task, paths, source),
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
  ...(scope.continueFrom ? { continueFrom: scope.continueFrom } : {}),
});
// An editor that needs paths outside the approved ones stops as blocked and names them in
// scope-request.json (MP-021). The controller records the request on the attempt when it names
// only paths the story does not have, which together with the approved ones pass the path rules
// against the snapshot the editor read, or records the problem instead. A request never changes
// the story: the director approves it by editing the story's files (editSourceStory).
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
          ? ' The controller runs the full test suite in its own sandbox after you stop. Report a check your environment could not run (for example local HTTP tests blocked by your sandbox) as not-run, and use fail only for a defect in the change.'
          : ''),
    );
  // Edits and new files come back as staged copies; a created file has no beforeHash and a deleted
  // one no afterHash. Size is bounded per file here and by the change's diff, not by a total.
  const writable = [...scope.allowedFiles, ...(scope.newFiles || [])],
    changes = [],
    seen = new Set();
  for (const artifact of result.artifacts) {
    const file = artifact.path.slice('changes/'.length);
    if (artifact.path === scopeRequestFile)
      throw new Error(
        `Return ${scopeRequestFile} only with outcome blocked; a completed change stays inside the approved paths.`,
      );
    if (
      !artifact.path.startsWith('changes/') ||
      !writable.includes(file) ||
      seen.has(file) ||
      artifact.kind !== 'source-file'
    )
      throw new Error('Staged source edits exceed the approved file scope.');
    seen.add(file);
    const contents = read(artifact.path),
      { fileBytes } = profileOf(scope.source).limits;
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
    diffed ? 'change.diff' : 'change-context.json',
    ...changes.filter(item => item.artifact).map(item => item.artifact),
  ];
  // Earlier candidates did not register the approved scope; when registered it must be the recorded one.
  if (attempt.artifacts.some(item => item.path === 'source-scope.json')) {
    paths.push('source-scope.json');
    if (!equal(JSON.parse(read('source-scope.json')), scopeDocument(scope)))
      throw new Error('The approved source scope does not match the recorded proposal.');
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
      stopped = stage.current === 'failed' && stage.phase === 'integration';
    if ((!open && !stopped) || (journal && !['rejected', 'abandoned'].includes(journal.state))) return null;
    const { summary, notes = [] } = report();
    return {
      findings: [
        `Independent review ${attempt.id} passed, and the director sent the change back for another attempt.`,
        `- ${summary}`,
        ...(notes.length ? ['Its notes, which did not block it:', ...notes.map(note => `- ${note}`)] : []),
      ].join('\n'),
      passed: true,
      needsNote: !notes.length,
    };
  }
  if (stage.current !== 'failed' || review.verdict !== 'needs-work') return null;
  const { summary, findings } = report();
  return {
    findings: [
      `Independent review ${attempt.id} requested changes. Address these findings:`,
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
    stage.integration
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
  // The director's override covers the review's verdict and its own failed checks, never the candidate's tests.
  if (!override && (verdict.verdict !== 'pass' || review.result.checks.some(check => check.status === 'fail')))
    throw new Error(
      'Integration requires a passing independent review, or your reason to integrate over a review that requested changes.',
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
  // The story integrates into the repository its scope measured: its project's (1.0 item 9).
  const root = candidate.sourceChange?.source?.root || runtime.sourceChangeRoot,
    commit = candidate.sourceCandidate?.commit;
  // A controller that develops its own source replaces its running modules, so it integrates
  // only while paused and idle, then restarts. Otherwise integration holds only its resources.
  if (
    runtime.selfHosted &&
    root === runtime.sourceChangeRoot &&
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
    repository: repositoryState(root, 'integrating source', { clean: false }),
    worktree: path.join(sourceWorktreeRoot(runtime), 'i-' + worktreeName(review.id)),
    startedAt: new Date().toISOString(),
    approvedBy: approval,
    ...(override
      ? {
          reviewOverride: {
            by: { type: 'director' },
            verdict: verdict.verdict,
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
    `Integration approved${override ? ` over the review's ${verdict.verdict} verdict, by the director: ${override.reason}` : approval.type === 'policy' ? ` by autonomy policy revision ${approval.revision} after the independent review passed` : ' by the director'}. The controller is merging the reviewed change onto ${journal.repository.branch} at ${journal.repository.head.slice(0, 7)} in its own worktree, then formatting and testing it; the development copy is unchanged until it passes.`,
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
  if (!verification.passed)
    return reject(
      verification.error ||
        (verification.totals
          ? `${verification.totals.pass}/${verification.totals.tests} tests passed on the formatted change.`
          : 'The test run did not report complete totals.'),
    );
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
      fastForward(root, journal);
      if (!landed(root, journal.commit))
        throw Object.assign(new Error('The development copy did not reach the integration commit.'), { partial: true });
    });
  } catch (error) {
    return error.partial ? attention(error.message) : reject(error.message);
  }
  if (!landed(root, journal.commit)) return attention('The development copy did not reach the integration commit.');
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
      ? `Candidate review: ${review.taskId} (${review.id}), verdict ${journal.reviewOverride.verdict}; integrated over it by the director: ${journal.reviewOverride.reason}`
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
  }
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
  if (journal.commit && landed(journal.root, journal.commit)) {
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
    return result;
  }
  // Verification never writes the development copy. A fast-forward refuses local edits to the
  // changed files, so edits there now may be what an interrupted one left: the director decides.
  if ((journal.interrupted ?? journal.state) !== 'verifying') {
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
  const store = runtime.store;
  task = sourceIntegrationTarget(store, task, task.acceptedAttemptId, task.sourceStage?.review?.hash);
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
