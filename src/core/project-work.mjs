// What a project's work made, for its Artifacts page (the redesign, approved October 29): the files the work handed
// back as its result, one row per file with each version and why it was made, the pictures each code story's visual
// check took, and how many records of how the work was done there are. Records (plans, reviews, check reports, test
// logs, a story's scope, context, diff and copies of the files it changed) stay on each idea and story and are only
// counted here, and a code project's code is in its repository. Read from the store; nothing is written.
import { libraryOf, currentEntries } from './library.mjs';
import { recordProject } from './projects.mjs';
import { runIdOf } from './graph.mjs';

// The kinds of file that record how work was done rather than being the work. Every kind a code story's step hands
// back starts with "source-"; an unknown kind is the work, so a new kind of result is listed until it is named here.
const recordKinds = new Set([
  'plan',
  'review',
  'result',
  'graph-proposal',
  'library-proposal',
  'test-log',
  'build-log',
  'check-report',
  'visual-check',
]);
export const isRecordKind = kind => recordKinds.has(kind) || /^source-/.test(kind || '');

// What an attempt was asked beyond the attempt before it: the direction's newer part when it adds to the earlier one
// (an automatic retry), or the whole of it when it was written anew (a review's findings and the director's note),
// in the record's own words, cut at its first paragraph and 280 characters.
const whyLimit = 280;
export function versionWhy(before, after) {
  const earlier = (before || '').trim(),
    later = (after || '').trim();
  if (!later || later === earlier) return null;
  const added = earlier && later.startsWith(earlier) ? later.slice(earlier.length).trim() : later,
    first = added
      .split(/\n\s*\n/)[0]
      .replace(/\s+/g, ' ')
      .trim();
  return first.length > whyLimit ? `${first.slice(0, whyLimit - 1)}…` : first || null;
}

const attemptOf = (store, id) => {
  try {
    return id ? store.attempt(id) : null;
  } catch {
    return null;
  }
};
const startedAt = attempt => attempt.startedAt || attempt.createdAt || '';

// The library entry, if any, whose newest revision came from this file of this task.
function libraryEntries(store, projectId) {
  const from = new Map();
  for (const entry of currentEntries(libraryOf(store, projectId))) {
    const source = entry.revisions?.at(-1)?.source;
    if (source?.type === 'accepted') from.set(`${source.taskId}\0${source.path}`, entry.id);
  }
  return from;
}

export function projectWork(store, projectId) {
  const work = [],
    pictures = [],
    records = { count: 0, kinds: {} },
    inLibrary = libraryEntries(store, projectId),
    record = kind => {
      records.count++;
      records.kinds[kind] = (records.kinds[kind] || 0) + 1;
    };
  for (const task of store.tasks()) {
    if (recordProject(task) !== projectId || task.status !== 'done' || !task.acceptedAttemptId) continue;
    const accepted = attemptOf(store, task.acceptedAttemptId);
    if (accepted?.status !== 'accepted') continue;
    const about = { taskId: task.id, title: task.title, runId: runIdOf(task) || null };
    // A code story's own files are records; the pictures its visual check took are on its accepted candidate.
    if (task.kind === 'studio-development:change' || task.sourceStage) {
      for (const item of accepted.artifacts || []) record(item.kind);
      const candidate = attemptOf(store, task.sourceStage?.candidate?.attemptId);
      const images = (candidate?.artifacts || []).filter(item => item.kind === 'visual-capture');
      if (images.length)
        pictures.push({
          ...about,
          attemptId: candidate.id,
          at: candidate.acceptedAt || candidate.finishedAt || null,
          images: images.map(({ path, hash }) => ({ path, hash })),
        });
      continue;
    }
    // Every attempt of the task that handed files back and was accepted, oldest first: each file's versions.
    const attempts = store
      .attempts(task.id)
      .filter(attempt => (attempt.status === 'accepted' || attempt.acceptedAt) && attempt.artifacts?.length)
      .sort((a, b) => startedAt(a).localeCompare(startedAt(b)));
    for (const item of accepted.artifacts || []) {
      if (isRecordKind(item.kind)) {
        record(item.kind);
        continue;
      }
      const made = attempts.filter(attempt => attempt.artifacts.some(file => file.path === item.path));
      if (!made.some(attempt => attempt.id === accepted.id)) made.push(accepted);
      const versions = made.map((attempt, index) => ({
        n: index + 1,
        attemptId: attempt.id,
        workerId: attempt.workerId || null,
        hash: attempt.artifacts.find(file => file.path === item.path)?.hash || null,
        at: attempt.acceptedAt || attempt.finishedAt || null,
        current: attempt.id === accepted.id,
        why: index ? versionWhy(made[index - 1].assignment?.direction, attempt.assignment?.direction) : null,
      }));
      work.push({
        ...about,
        path: item.path,
        kind: item.kind,
        hash: item.hash,
        attemptId: accepted.id,
        workerId: accepted.workerId || null,
        acceptedAt: accepted.acceptedAt || null,
        libraryEntryId: inLibrary.get(`${task.id}\0${item.path}`) || null,
        versions: versions.reverse(),
      });
    }
  }
  const newest = (a, b) => (b.acceptedAt || b.at || '').localeCompare(a.acceptedAt || a.at || '');
  return { work: work.sort(newest), pictures: pictures.sort(newest), records };
}
