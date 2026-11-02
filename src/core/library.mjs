// A project's library (1.2 step 6, decided October 28, 2026): the files its later work should follow, such as brand
// guidelines, a design system, a spec or a data set. Each entry has a name, a line on what it is for, and revisions:
// adding a newer file in its place makes a new revision and keeps the old one. The director adds an entry from any
// accepted file or uploads one; an entry copied to another project keeps where it came from. A library belongs to one
// project and, on a code project, sits beside the repository, never committed by itself. Domain-free: an entry is a
// file with its provenance, whatever the project does.
//
// The index is the setting `library:<projectId>` ({ entries: [{ id, name, purpose, createdAt, by, removedAt?,
// revisions: [{ revision, file, mediaType, byteLength, sha256, source, at, by }] }] }); each revision's bytes are a file
// of their own under <data>/projects/<projectId>/library/<entryId>/, written once and checked by hash on every read.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acceptedReference, artifactPath } from './artifacts.mjs';
import { projectIdentity, recordProject } from './projects.mjs';
import { runIdOf } from './graph.mjs';
import { checkContent, safeName } from './idea-inputs.mjs';

export const libraryLimits = Object.freeze({
  entries: 50,
  revisions: 50,
  fileBytes: 5 * 1024 * 1024,
  wireBytes: 7 * 1024 * 1024,
});
// The files a library keeps: those an idea accepts, and the text kinds work hands back.
const types = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.csv', 'text/csv'],
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.svg', 'image/svg+xml'],
  ['.xml', 'application/xml'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.ts', 'text/plain'],
  ['.tsx', 'text/plain'],
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
// Whether a task's work is finished, so a file it handed back can join the library: a task with stages, such as a
// step and its review, is accepted when its last stage is. An unknown task is left to the accepted-file check.
const workFinished = (store, taskId) => {
  let task;
  try {
    task = store.task(taskId);
  } catch {
    return true;
  }
  return task?.status !== undefined ? task.status === 'done' : true;
};
const bounded = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
const settingId = projectId => `library:${projectId}`;
const entryIdentity = /^lib-[0-9a-f-]{36}$/;

export const mediaTypeOf = name => types.get(path.extname(name).toLowerCase()) || null;

// The project's library as recorded.
export function libraryOf(store, projectId) {
  projectIdentity(projectId);
  return store.setting(settingId(projectId)) || { entries: [] };
}
// The entries later work follows: those not removed, each at its newest revision.
export const currentEntries = library => library.entries.filter(entry => !entry.removedAt);

function libraryEntry(store, projectId, entryId) {
  if (typeof entryId !== 'string' || !entryIdentity.test(entryId)) throw failure('Library entry not found.', 404);
  const library = libraryOf(store, projectId),
    entry = library.entries.find(item => item.id === entryId);
  if (!entry) throw failure('Library entry not found.', 404);
  return { library, entry };
}
const entryFolder = (store, projectId, entryId) =>
  path.join(store.directory, 'projects', projectId, 'library', entryId);
const revisionFile = (store, projectId, entryId, revision) =>
  path.join(
    entryFolder(store, projectId, entryId),
    `r${revision.revision}${path.extname(revision.file).toLowerCase()}`,
  );

// The bytes a new revision holds, with where they came from: an upload ({ file: { name, mediaType?, data } }, base64,
// as an idea's files) or an accepted file ({ from: { taskId, attemptId?, path } }, one of that accepted attempt's
// files, read and checked against its recorded hash).
function sourceBytes(store, projectId, data) {
  const keys = ['file', 'from'].filter(key => data?.[key] !== undefined);
  if (keys.length !== 1) throw failure('Give the library either an uploaded file or an accepted file, not both.');
  if (data.file) {
    const file = data.file;
    if (
      !file ||
      typeof file !== 'object' ||
      Array.isArray(file) ||
      Object.keys(file).some(key => !['name', 'mediaType', 'data'].includes(key))
    )
      throw failure('An uploaded file takes only name, mediaType and base64 data.');
    safeName(file.name);
    const mediaType = mediaTypeOf(file.name);
    if (!mediaType || (file.mediaType && file.mediaType !== mediaType))
      throw failure(
        'The library keeps images, JSON, Markdown, plain text, CSV, HTML, CSS, SVG, XML, YAML and code files.',
      );
    if (
      typeof file.data !== 'string' ||
      file.data.length > libraryLimits.wireBytes ||
      file.data.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
    )
      throw failure('An uploaded file must be canonical base64 of at most 5 MiB.');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data) throw failure('An uploaded file must be canonical base64.');
    if (bytes.length > libraryLimits.fileBytes) throw failure('A library file is at most 5 MiB.', 413);
    checkContent(bytes, mediaType);
    return { bytes, file: file.name, mediaType, source: { type: 'upload' } };
  }
  const from = data.from;
  if (
    !from ||
    typeof from !== 'object' ||
    Array.isArray(from) ||
    Object.keys(from).some(key => !['taskId', 'attemptId', 'path'].includes(key)) ||
    typeof from.taskId !== 'string' ||
    typeof from.path !== 'string'
  )
    throw failure('An accepted file names its task, optionally its attempt, and its path.');
  if (!workFinished(store, from.taskId))
    throw failure(
      "That work isn't finished yet: its file can join the library once its review passes and the work is accepted.",
      409,
    );
  let reference;
  try {
    reference = acceptedReference(store, from.taskId, from.attemptId, projectId);
  } catch {
    throw failure('Only a file from accepted work joins the library: that attempt is not the one you accepted.', 409);
  }
  const item = reference.artifacts.find(artifact => artifact.path === from.path);
  if (!item) throw failure('That file is not one the accepted work handed back.', 404);
  const name = path.basename(item.path),
    mediaType = mediaTypeOf(name);
  if (!mediaType)
    throw failure(
      'The library keeps images, JSON, Markdown, plain text, CSV, HTML, CSS, SVG, XML, YAML and code files.',
    );
  const bytes = fs.readFileSync(artifactPath(store, store.attempt(reference.attemptId), item.path));
  if (sha256(bytes) !== item.hash) throw failure('The accepted file changed after it was accepted.', 409);
  if (bytes.length > libraryLimits.fileBytes) throw failure('A library file is at most 5 MiB.', 413);
  return {
    bytes,
    file: name,
    mediaType,
    source: {
      type: 'accepted',
      taskId: reference.taskId,
      attemptId: reference.attemptId,
      path: item.path,
      hash: item.hash,
    },
  };
}

function writeRevision(store, projectId, entry, revision, bytes) {
  const file = revisionFile(store, projectId, entry.id, revision);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written once: a revision's bytes never change.
  fs.writeFileSync(file, bytes, { flag: 'wx' });
}
function newRevision(entry, { bytes, file, mediaType, source }, by) {
  return {
    revision: (entry.revisions.at(-1)?.revision || 0) + 1,
    file,
    mediaType,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    source,
    at: new Date().toISOString(),
    by,
  };
}
function saveLibrary(store, projectId, library) {
  store.putSetting(settingId(projectId), { ...library, projectId });
}

// Adds an entry: a name, what it is for, and its first revision.
export function addLibraryEntry(store, projectId, data, by = { type: 'director' }) {
  if (
    !data ||
    typeof data !== 'object' ||
    Object.keys(data).some(key => !['name', 'purpose', 'file', 'from'].includes(key))
  )
    throw failure('A library entry takes a name, what it is for, and a file.');
  if (!bounded(data.name, 120)) throw failure('A library entry needs a name of at most 120 characters.');
  if (!bounded(data.purpose, 500)) throw failure('Say in at most 500 characters what the entry is for.');
  const library = libraryOf(store, projectId);
  if (currentEntries(library).length >= libraryLimits.entries)
    throw failure(`A library holds at most ${libraryLimits.entries} entries.`, 409);
  if (currentEntries(library).some(entry => entry.name.toLowerCase() === data.name.trim().toLowerCase()))
    throw failure(`The library already has an entry named ${data.name.trim()}; add a new revision to it instead.`, 409);
  const source = sourceBytes(store, projectId, data),
    entry = {
      id: `lib-${randomUUID()}`,
      name: data.name.trim(),
      purpose: data.purpose.trim(),
      createdAt: new Date().toISOString(),
      by,
      revisions: [],
    },
    revision = newRevision(entry, source, by);
  writeRevision(store, projectId, entry, revision, source.bytes);
  entry.revisions.push(revision);
  library.entries.push(entry);
  saveLibrary(store, projectId, library);
  store.event(
    'library_added',
    null,
    null,
    `${by.type === 'director' ? 'The director' : 'The autonomy policy'} added ${entry.name} to the library: ${entry.purpose}`,
    projectId,
  );
  return entry;
}

// A newer file in an entry's place: a new revision, the old ones kept.
export function reviseLibraryEntry(store, projectId, entryId, data, by = { type: 'director' }) {
  if (!data || typeof data !== 'object' || Object.keys(data).some(key => !['file', 'from'].includes(key)))
    throw failure('A new revision takes only a file.');
  const { library, entry } = libraryEntry(store, projectId, entryId);
  if (entry.removedAt) throw failure('This entry was removed from the library.', 409);
  if (entry.revisions.length >= libraryLimits.revisions)
    throw failure(`An entry keeps at most ${libraryLimits.revisions} revisions.`, 409);
  const source = sourceBytes(store, projectId, data);
  if (source.bytes.length && sha256(source.bytes) === entry.revisions.at(-1).sha256)
    throw failure('That file is the same as the newest revision.', 409);
  const revision = newRevision(entry, source, by);
  writeRevision(store, projectId, entry, revision, source.bytes);
  entry.revisions.push(revision);
  saveLibrary(store, projectId, library);
  store.event(
    'library_revised',
    null,
    null,
    `The director added revision ${revision.revision} of ${entry.name} to the library.`,
    projectId,
  );
  return entry;
}

// The entry's name or what it is for, changed; its revisions stay.
export function editLibraryEntry(store, projectId, entryId, data) {
  if (
    !data ||
    typeof data !== 'object' ||
    Object.keys(data).some(key => !['name', 'purpose'].includes(key)) ||
    !Object.keys(data).length
  )
    throw failure('An entry edit takes a name, what it is for, or both.');
  const { library, entry } = libraryEntry(store, projectId, entryId);
  if (data.name !== undefined) {
    if (!bounded(data.name, 120)) throw failure('A library entry needs a name of at most 120 characters.');
    if (
      currentEntries(library).some(
        item => item.id !== entryId && item.name.toLowerCase() === data.name.trim().toLowerCase(),
      )
    )
      throw failure(`The library already has an entry named ${data.name.trim()}.`, 409);
    entry.name = data.name.trim();
  }
  if (data.purpose !== undefined) {
    if (!bounded(data.purpose, 500)) throw failure('Say in at most 500 characters what the entry is for.');
    entry.purpose = data.purpose.trim();
  }
  saveLibrary(store, projectId, library);
  return entry;
}

// Removes an entry from the library for later work; its revisions and the attempts that read them stay recorded.
export function removeLibraryEntry(store, projectId, entryId) {
  const { library, entry } = libraryEntry(store, projectId, entryId);
  if (!entry.removedAt) {
    entry.removedAt = new Date().toISOString();
    saveLibrary(store, projectId, library);
    store.event(
      'library_removed',
      null,
      null,
      `The director removed ${entry.name} from the library; later work no longer receives it.`,
      projectId,
    );
  }
  return entry;
}

// One revision's bytes, checked against its recorded hash.
export function readLibraryRevision(store, projectId, entryId, number) {
  const { entry } = libraryEntry(store, projectId, entryId),
    revision = entry.revisions.find(item => item.revision === Number(number));
  if (!revision) throw failure('Library revision not found.', 404);
  let bytes;
  try {
    bytes = fs.readFileSync(revisionFile(store, projectId, entryId, revision));
  } catch {
    throw failure('The library file is missing.', 409);
  }
  if (sha256(bytes) !== revision.sha256 || bytes.length !== revision.byteLength)
    throw failure('The library file changed after it was added.', 409);
  return { entry, revision, bytes };
}

// Copies an entry's newest revision into another project's library, keeping where it came from.
export function copyLibraryEntry(store, projectId, entryId, targetProjectId) {
  store.project(targetProjectId);
  if (targetProjectId === projectId) throw failure('Copy the entry to another project.');
  const { entry, revision, bytes } = readLibraryRevision(
    store,
    projectId,
    entryId,
    libraryEntry(store, projectId, entryId).entry.revisions.at(-1).revision,
  );
  if (entry.removedAt) throw failure('This entry was removed from the library.', 409);
  const target = libraryOf(store, targetProjectId);
  if (currentEntries(target).length >= libraryLimits.entries)
    throw failure(`That project's library holds ${libraryLimits.entries} entries already.`, 409);
  if (currentEntries(target).some(item => item.name.toLowerCase() === entry.name.toLowerCase()))
    throw failure(`That project's library already has an entry named ${entry.name}.`, 409);
  const copy = {
      id: `lib-${randomUUID()}`,
      name: entry.name,
      purpose: entry.purpose,
      createdAt: new Date().toISOString(),
      by: { type: 'director' },
      revisions: [],
    },
    copied = newRevision(
      copy,
      {
        bytes,
        file: revision.file,
        mediaType: revision.mediaType,
        source: { type: 'copy', projectId, entryId, revision: revision.revision, sha256: revision.sha256 },
      },
      { type: 'director' },
    );
  writeRevision(store, targetProjectId, copy, copied, bytes);
  copy.revisions.push(copied);
  target.entries.push(copy);
  saveLibrary(store, targetProjectId, target);
  store.event(
    'library_added',
    null,
    null,
    `The director copied ${entry.name} into this project's library from another project.`,
    targetProjectId,
  );
  return copy;
}

// How much of the library sits beside each attempt's work: files in the library's order until this many bytes; the
// rest are in the index alone (decided October 28: every file read-only, up to a size limit).
export const libraryDeliveryBytes = 20 * 1024 * 1024;

// What one attempt receives from the library, recorded with it: each entry's newest revision with its hash and where it
// sits (../library/<entry>-r<revision><ext> beside the work, read-only), whether it was delivered, and the entries its
// idea left out. A review or check receives exactly what the work it reviews received, so it checks against the same
// revisions (v1.0 item 26). `delivery` is the step contract's (`receives.library`), whatever the step's kind is called.
export function libraryFor(store, task, inputs = [], { delivery = 'current' } = {}) {
  const projectId = task.projectId;
  if (delivery === 'none') return { references: [], leftOut: [] };
  if (delivery === 'same-as-inputs')
    for (const input of inputs) {
      if (!input.attemptId) continue;
      let reviewed;
      try {
        reviewed = store.attempt(input.attemptId);
      } catch {
        continue;
      }
      if (reviewed.libraryReferences)
        return {
          references: structuredClone(reviewed.libraryReferences),
          leftOut: structuredClone(reviewed.libraryLeftOut || []),
        };
    }
  const runId = runIdOf(task),
    run = runId ? store.run(runId) : null,
    leftOutIds = new Set(run?.libraryLeftOut || []),
    entries = currentEntries(libraryOf(store, projectId));
  let delivered = 0;
  const references = entries
    .filter(entry => !leftOutIds.has(entry.id))
    .map(entry => {
      const revision = entry.revisions.at(-1),
        fits = delivered + revision.byteLength <= libraryDeliveryBytes;
      if (fits) delivered += revision.byteLength;
      return {
        entryId: entry.id,
        name: entry.name,
        purpose: entry.purpose,
        revision: revision.revision,
        file: revision.file,
        mediaType: revision.mediaType,
        byteLength: revision.byteLength,
        sha256: revision.sha256,
        path: `../library/${entry.id}-r${revision.revision}${path.extname(revision.file).toLowerCase()}`,
        delivered: fits,
      };
    });
  return {
    references,
    leftOut: entries.filter(entry => leftOutIds.has(entry.id)).map(entry => ({ entryId: entry.id, name: entry.name })),
  };
}

// Puts the attempt's delivered library files beside its work, read-only: each checked against its recorded hash, and
// protected, so a change to one fails the attempt.
export function stageLibrary(store, entry) {
  const projectId = entry.attempt.projectId;
  for (const reference of entry.attempt.libraryReferences || []) {
    if (!reference.delivered) continue;
    try {
      const { revision, bytes } = readLibraryRevision(store, projectId, reference.entryId, reference.revision);
      if (revision.sha256 !== reference.sha256) throw failure('The library file changed after it was recorded.', 409);
      const destination = path.resolve(entry.output, reference.path);
      // The destination is the controller's own, never a name from an upload.
      if (!destination.startsWith(path.join(entry.job, 'library') + path.sep))
        throw failure('Invalid library destination.');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: 'wx' });
      entry.protectedFiles.set(destination, reference.sha256);
    } catch (error) {
      entry.needsDecision = true;
      throw new Error(`Library file ${reference.name}: ${error.message}`);
    }
  }
}

// The director leaves named entries out of an idea, for all of its work from then on; each attempt records what it left
// out. The planner cannot drop a file.
export function setIdeaLibraryLeftOut(store, projectId, runId, entryIds) {
  const run = store.run(runId);
  if (!run || run.projectId !== projectId) throw failure('Idea not found.', 404);
  const library = libraryOf(store, projectId);
  if (!Array.isArray(entryIds) || entryIds.length > libraryLimits.entries || new Set(entryIds).size !== entryIds.length)
    throw failure('Name the library entries to leave out of this idea, each once.');
  for (const id of entryIds)
    if (!library.entries.some(entry => entry.id === id)) throw failure(`Library entry ${id} not found.`, 404);
  run.libraryLeftOut = [...entryIds];
  store.putRun(run);
  store.event(
    'library_left_out',
    null,
    null,
    entryIds.length
      ? `The director left ${entryIds.map(id => library.entries.find(entry => entry.id === id).name).join(', ')} out of this idea's work.`
      : "The director gave this idea's work the whole library again.",
    projectId,
  );
  return { runId, libraryLeftOut: run.libraryLeftOut };
}

// The attempts that read an entry, newest first, with the revision each received and whether it sat beside the work.
export function libraryReaders(store, projectId, entryId) {
  libraryEntry(store, projectId, entryId);
  return store
    .attemptsNaming([entryId])
    .filter(attempt => attempt.projectId === projectId)
    .flatMap(attempt => {
      const reference = (attempt.libraryReferences || []).find(item => item.entryId === entryId);
      return reference
        ? [
            {
              attemptId: attempt.id,
              taskId: attempt.taskId,
              status: attempt.status,
              startedAt: attempt.startedAt,
              revision: reference.revision,
              delivered: reference.delivered,
            },
          ]
        : [];
    })
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

// An agent proposes a library entry (decided October 28): a completed attempt may return library-proposal.json
// ({ "schemaVersion": "library-proposal-v1", "proposals": [{ "name", "purpose", "path": one of its own files,
// "entryId"?: an entry to add a revision to }] }, at most five). When the work is accepted, each proposal is recorded;
// with the project's autonomy policy on, the policy approves it at once, and otherwise it waits for the director.
export const libraryProposalFile = 'library-proposal.json';
export function readLibraryProposal(attempt, read) {
  if (!attempt.artifacts?.some(item => item.path === libraryProposalFile)) return [];
  let report;
  try {
    report = JSON.parse(read(libraryProposalFile));
  } catch {
    throw failure(`${libraryProposalFile} is not readable JSON.`);
  }
  if (
    report?.schemaVersion !== 'library-proposal-v1' ||
    !Array.isArray(report.proposals) ||
    !report.proposals.length ||
    report.proposals.length > 5
  )
    throw failure(`${libraryProposalFile} must hold one to five proposals in library-proposal-v1.`);
  return report.proposals.map((item, index) => {
    const at = `Library proposal ${index + 1}`;
    if (
      !item ||
      typeof item !== 'object' ||
      Object.keys(item).some(key => !['name', 'purpose', 'path', 'entryId'].includes(key))
    )
      throw failure(`${at} takes a name, what it is for, the path of one of your files, and optionally an entry.`);
    if (!bounded(item.name, 120) || !bounded(item.purpose, 500))
      throw failure(`${at} needs a name and what it is for.`);
    if (item.path === libraryProposalFile || !attempt.artifacts.some(artifact => artifact.path === item.path))
      throw failure(`${at} must name one of the files this attempt handed back.`);
    if (item.entryId !== undefined && (typeof item.entryId !== 'string' || !entryIdentity.test(item.entryId)))
      throw failure(`${at} names an entry that is not one of the library's.`);
    return {
      name: item.name.trim(),
      purpose: item.purpose.trim(),
      path: item.path,
      ...(item.entryId ? { entryId: item.entryId } : {}),
    };
  });
}

function settleProposal(store, projectId, proposal, by) {
  const from = proposal.from;
  try {
    const entry = proposal.entryId
      ? reviseLibraryEntry(store, projectId, proposal.entryId, { from }, by)
      : addLibraryEntry(store, projectId, { name: proposal.name, purpose: proposal.purpose, from }, by);
    return { state: 'approved', entryId: entry.id, decidedAt: new Date().toISOString(), decidedBy: by };
  } catch (error) {
    return { state: 'refused', problem: error.message, decidedAt: new Date().toISOString(), decidedBy: by };
  }
}

// Records an accepted attempt's proposals; the policy, when on, approves them once the work is finished, which may be
// this acceptance (a review's, say, finishing a step whose attempt proposed them).
export function recordLibraryProposals(store, task, attempt, read, policy) {
  const proposals = readLibraryProposal(attempt, read);
  if (!proposals.length) {
    settleTaskProposals(store, store.task(task.id), policy);
    return [];
  }
  const projectId = attempt.projectId,
    recorded = proposals.map(item => ({
      id: `libprop-${randomUUID()}`,
      ...item,
      from: { taskId: task.id, attemptId: attempt.id, path: item.path },
      proposedBy: attempt.workerId,
      at: new Date().toISOString(),
      state: 'waiting',
    }));
  const library = libraryOf(store, projectId);
  library.proposals = [...(library.proposals || []), ...recorded].slice(-100);
  saveLibrary(store, projectId, library);
  for (const proposal of recorded) {
    store.event(
      'library_proposed',
      task.id,
      attempt.id,
      `${proposal.proposedBy} proposed ${proposal.name} for the library: ${proposal.purpose}`,
      projectId,
    );
  }
  // Work with stages, such as a step and its review, is finished only when its last stage is accepted; its
  // proposals wait until then (October 29: the policy refused a glossary while its review was still to come).
  settleTaskProposals(store, store.task(task.id), policy);
  return recorded;
}

// Once a task's work is finished, the policy, when on, decides the proposals its attempts made that still wait.
export function settleTaskProposals(store, task, policy) {
  if (!policy?.enabled || task.status !== 'done') return;
  const projectId = recordProject(task),
    waiting = (libraryOf(store, projectId).proposals || []).filter(
      item => item.state === 'waiting' && item.from?.taskId === task.id,
    );
  for (const proposal of waiting)
    decideLibraryProposal(store, projectId, proposal.id, true, { type: 'policy', revision: policy.revision });
}

// The director, or the policy, approves or rejects a waiting proposal.
export function decideLibraryProposal(store, projectId, proposalId, approve, by = { type: 'director' }) {
  const library = libraryOf(store, projectId),
    proposal = (library.proposals || []).find(item => item.id === proposalId);
  if (!proposal) throw failure('Library proposal not found.', 404);
  if (proposal.state !== 'waiting') throw failure(`This proposal was already ${proposal.state}.`, 409);
  // Approving work that isn't finished is refused without deciding, so the proposal waits for it.
  if (approve && !workFinished(store, proposal.from.taskId))
    throw failure(
      "That work isn't finished yet: its file can join the library once its review passes and the work is accepted.",
      409,
    );
  const outcome = approve
    ? settleProposal(store, projectId, proposal, by)
    : { state: 'rejected', decidedAt: new Date().toISOString(), decidedBy: by };
  // The entry was added through the library's own index; read it again before recording the outcome.
  const current = libraryOf(store, projectId),
    stored = current.proposals.find(item => item.id === proposalId);
  Object.assign(stored, outcome);
  saveLibrary(store, projectId, current);
  const who = by.type === 'policy' ? `The autonomy policy (revision ${by.revision})` : 'The director';
  store.event(
    'library_decided',
    stored.from.taskId,
    stored.from.attemptId,
    outcome.state === 'approved'
      ? `${who} approved ${stored.name} for the library.`
      : outcome.state === 'rejected'
        ? `${who} rejected ${stored.name} for the library.`
        : `${who} could not add ${stored.name} to the library: ${outcome.problem}`,
    projectId,
  );
  return stored;
}
