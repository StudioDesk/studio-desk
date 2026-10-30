// What the Artifacts page reads from what the project's work made (GET …/work, 1.2 step 6): each file's readable
// name, its kind, its one line and its versions' words, the All, Documents and Images filter with the idea and agent
// choices, and the words for the records and the visual checks' pictures.
import type { Live, ProjectArtifact, ProjectWork, Shell, WorkFile, WorkPictures, WorkVersion } from './api';
import { imageFile } from './files';
import { workerName } from './names';
import { quoted, when } from './today';

// The records the page holds: the shell's agents, and the live set's runs and the ideas it names.
export type ArtifactRecords =
  | (Pick<Shell, 'workers' | 'employeeDirectory'> & Partial<Pick<Live, 'runs' | 'ideas'>>)
  | null;

// One value a filter can take: what it matches, and its words.
export interface Choice {
  value: string;
  label: string;
}

// The idea's words when the records hold its run, or a finished idea they name.
function ideaWords(records: ArtifactRecords, runId: string | null) {
  if (!runId) return null;
  const run = records?.runs?.find(item => item.id === runId),
    brief = typeof run?.brief === 'string' ? run.brief : records?.ideas?.find(idea => idea.id === runId)?.brief;
  return brief?.trim() ? quoted(brief, 60) : null;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// A file's name as a person would say it: the last part of its path without its extension, hyphens and underscores
// as spaces, first letter capital (copy/launch-page.md reads Launch page). A name that is only an extension, such as
// .gitignore, reads as itself.
export function readableName(path: string) {
  const file = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
    stem = file.replace(/\.[^.]*$/, '') || file,
    words = stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || file;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A file is an Image when it is one of the pictures the dashboard shows (files.tsx imageFile), otherwise a Document.
export type WorkKind = 'Document' | 'Image';
export const workKind = (path: string): WorkKind => (imageFile(path) ? 'Image' : 'Document');

// The page's filter: every file, the documents or the images, and any idea and any agent unless one is chosen.
export type WorkShow = 'all' | 'documents' | 'images';
export const workShows: { value: WorkShow; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'documents', label: 'Documents' },
  { value: 'images', label: 'Images' },
];
export interface WorkFilter {
  show?: WorkShow;
  idea?: string;
  agent?: string;
}

export interface WorkRow {
  key: string;
  file: WorkFile;
  name: string;
  kind: WorkKind;
  agent: Choice;
  idea: Choice;
  // The latest date the file was made or accepted.
  at: string | null;
}

// Each file as the work lists it, newest first: its readable name and kind, its agent's name, and its idea's words when
// the records hold its run, otherwise its step's title, both quoted.
export function workRows(files: WorkFile[], records: ArtifactRecords): WorkRow[] {
  return files.map(file => {
    const words = ideaWords(records, file.runId),
      dates = [file.acceptedAt, ...file.versions.map(version => version.at)].filter((at): at is string => !!at);
    return {
      key: `${file.attemptId}/${file.path}`,
      file,
      name: readableName(file.path),
      kind: workKind(file.path),
      agent: { value: `agent:${file.workerId ?? ''}`, label: workerName(records, file.workerId ?? undefined) },
      idea: words
        ? { value: `run:${file.runId}`, label: words }
        : { value: `task:${file.taskId}`, label: quoted(file.title, 60) },
      at: dates.sort().at(-1) ?? null,
    };
  });
}

// A row's one line: "Ada · “Make the launch page” · Oct 20".
export const workLine = (row: WorkRow, now = new Date()) =>
  [row.agent.label, row.idea.label, when(row.at, now)].filter(Boolean).join(' · ');

// Open opens the newest version, or the accepted attempt's file when the work lists no versions.
export const newestAttemptId = (file: Pick<WorkFile, 'attemptId' | 'versions'>) =>
  file.versions[0]?.attemptId ?? file.attemptId;

// The file as Add to the library takes an accepted file: from its accepted attempt, as the controller checks it.
export const acceptedFile = (file: WorkFile): ProjectArtifact => ({
  taskId: file.taskId,
  title: file.title,
  attemptId: file.attemptId,
  workerId: file.workerId ?? undefined,
  runId: file.runId,
  kind: file.kind,
  path: file.path,
  hash: file.hash,
  acceptedAt: file.acceptedAt,
});

// The idea and agent choices, each starting with any idea or any agent, which matches every row, then each value the
// rows hold once: ideas newest first, as the work lists them, and agents by name.
export function workChoices(rows: WorkRow[], facet: 'idea' | 'agent'): Choice[] {
  const seen = new Map<string, Choice>();
  for (const row of rows) if (!seen.has(row[facet].value)) seen.set(row[facet].value, row[facet]);
  const list = [...seen.values()];
  return [
    { value: '', label: facet === 'idea' ? 'Any idea' : 'Any agent' },
    ...(facet === 'idea' ? list : list.sort((a, b) => a.label.localeCompare(b.label))),
  ];
}

const showsKind: Record<WorkShow, WorkKind | null> = { all: null, documents: 'Document', images: 'Image' };
export function matchingWork(rows: WorkRow[], filter: WorkFilter) {
  const kind = showsKind[filter.show ?? 'all'];
  return rows.filter(
    row =>
      (!kind || row.kind === kind) &&
      (!filter.idea || row.idea.value === filter.idea) &&
      (!filter.agent || row.agent.value === filter.agent),
  );
}

// "3 files · 5 versions".
export function workCount(files: Pick<WorkFile, 'versions'>[]) {
  const versions = files.reduce((sum, file) => sum + file.versions.length, 0);
  return `${plural(files.length, 'file')} · ${plural(versions, 'version')}`;
}

// "3 versions" on a file made more than once; a file made once has no words for it.
export const versionCount = (file: Pick<WorkFile, 'versions'>) =>
  file.versions.length > 1 ? plural(file.versions.length, 'version') : null;

// Why a version was made: the first is the first version; a later one in the words the records hold, or plainly that
// none were recorded.
export const versionWhy = (version: Pick<WorkVersion, 'n' | 'why'>) =>
  version.n === 1 ? 'The first version' : version.why?.trim() || 'Nothing was recorded about why it was made.';

// The line under the work: how many records of how it was done there are and where they stay, in a code project's
// words or any other project's; none has no line.
export function recordsSentence(records: ProjectWork['records'], code: boolean) {
  if (!records.count) return null;
  return code
    ? `${plural(records.count, 'record')} of how the stories were built. Reviews, test results, plans and the copies of changed files stay on each story's Changes, Checks and Activity. They are never listed here.`
    : `${plural(records.count, 'record')} of how the work was done. The plans, reviews and check results stay on each idea and story, where they explain the work. They are never listed here.`;
}

// A code story's visual check as its row reads: "The visual check · “the story's title” · Oct 20 · 4 pictures".
export const picturesLine = (pictures: WorkPictures, now = new Date()) =>
  ['The visual check', quoted(pictures.title, 60), when(pictures.at, now), plural(pictures.images.length, 'picture')]
    .filter(Boolean)
    .join(' · ');
